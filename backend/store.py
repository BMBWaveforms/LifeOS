"""SQLite memory, fixed guide retrieval, source validation and summary transactions."""
import argparse
import hashlib
import html
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]


class Store:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'memory.sqlite'
        self.lock = threading.RLock()
        self.runs = {}
        self.conversation_revisions = {}
        self.guide = json.loads((ROOT / 'data/guide.json').read_text())
        self.entries = {e['guide_id']: e for e in self.guide['entries']}
        config_path = self.directory / 'profiles.json'
        if not config_path.exists():
            config_path.write_text(json.dumps({
                'alice': {'name': '体验用户 A', 'token': secrets.token_urlsafe(32)},
                'bob': {'name': '体验用户 B', 'token': secrets.token_urlsafe(32)}}, ensure_ascii=False))
            config_path.chmod(0o600)
        self.profiles = json.loads(config_path.read_text())
        with self.db() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL, state TEXT NOT NULL, expires REAL);
                CREATE TABLE IF NOT EXISTS feedback (owner TEXT, guide_id TEXT, kind TEXT, PRIMARY KEY(owner,guide_id));
                CREATE TABLE IF NOT EXISTS memory_summaries (
                    memory_id TEXT PRIMARY KEY, source_run TEXT UNIQUE NOT NULL,
                    user_state TEXT NOT NULL, problem TEXT NOT NULL, problem_status TEXT NOT NULL,
                    guide_ids TEXT NOT NULL, followup_of TEXT NOT NULL DEFAULT '',
                    state_evidence TEXT NOT NULL DEFAULT '', status_evidence TEXT NOT NULL DEFAULT '');
            ''')
            for owner in self.profiles:
                db.execute('INSERT OR IGNORE INTO profiles(id) VALUES (?)', (owner,))

    def db(self):
        db = sqlite3.connect(str(self.path), timeout=10)
        db.row_factory = sqlite3.Row
        return db

    def owner(self, token):
        for owner, p in self.profiles.items():
            if token and secrets.compare_digest(token, p['token']):
                return owner
        raise PermissionError('无效的体验用户凭据')

    def state(self, owner):
        with self.db() as db:
            p = dict(db.execute('SELECT * FROM profiles WHERE id=?', (owner,)).fetchone())
            memories = [dict(m) for m in db.execute('SELECT * FROM memories WHERE owner=? ORDER BY created', (owner,))]
            feedback = [dict(f) for f in db.execute('SELECT * FROM feedback WHERE owner=?', (owner,))]
            details = {d['memory_id']:dict(d) for d in db.execute('SELECT s.* FROM memory_summaries s JOIN memories m ON m.id=s.memory_id WHERE m.owner=?',(owner,))}
        for m in memories:
            m.pop('owner', None)
            if m['id'] in details:
                detail=details[m['id']];detail.pop('memory_id');detail.pop('source_run')
                detail['guide_ids']=json.loads(detail['guide_ids'])
                detail['guides']=[{'guide_id':gid,'title':self.entries[gid]['title']} for gid in detail['guide_ids']]
                m.update(detail,origin='model_summary')
        effective = [m for m in memories if m['state']=='active' and (m['expires'] is None or m['expires'] > time.time())] if p['enabled'] else []
        return {'enabled': bool(p['enabled']), 'revision': p['revision'], 'memories': memories, 'effective': effective, 'feedback': feedback}

    def change(self, owner, action, data):
        with self.lock, self.db() as db:
            if action == 'settings':
                if not isinstance(data.get('enabled'), bool):
                    raise ValueError('enabled 必须为布尔值')
                db.execute('UPDATE profiles SET enabled=? WHERE id=?', (int(data['enabled']),owner))
            elif action == 'save':
                if not self.state(owner)['enabled']:
                    raise ValueError('请先开启记忆')
                if data.get('confirmed') is not True:
                    raise ValueError('仅保存用户确认的内容')
                kind = data.get('kind', 'condition')
                if kind not in ('condition','concern','action'):
                    raise ValueError('未知记忆类型')
                text = str(data.get('text','')).strip()
                if not text or len(text)>600:
                    raise ValueError('记忆内容长度应为 1—600 字')
                mid = data.get('id') or secrets.token_hex(12)
                existing = db.execute('SELECT owner FROM memories WHERE id=?',(mid,)).fetchone()
                if existing and existing['owner'] != owner:
                    raise PermissionError('不能修改其他用户记忆')
                now = time.time()
                if existing and db.execute('SELECT 1 FROM memory_summaries WHERE memory_id=?',(mid,)).fetchone():
                    raise ValueError('会话摘要请使用纠正操作，不要改成手动条件')
                expires = data.get('expires')
                if expires is not None and (not isinstance(expires,(float,int)) or expires <= now):
                    raise ValueError('有效期必须是未来时间')
                db.execute('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET text=excluded.text,kind=excluded.kind,updated=excluded.updated,state=excluded.state,expires=excluded.expires',
                           (mid,owner,kind,text,now,now,data.get('state','active'),expires))
            elif action == 'correct_summary':
                mid=data.get('id','')
                row=db.execute('SELECT m.owner,s.problem_status FROM memories m JOIN memory_summaries s ON m.id=s.memory_id WHERE m.id=?',(mid,)).fetchone()
                if not row or row['owner']!=owner:raise PermissionError('不能修改其他用户摘要')
                text=str(data.get('text','')).strip()
                if not text or len(text)>800:raise ValueError('摘要长度应为 1—800 字')
                problem_status=data.get('problem_status',row['problem_status'])
                if problem_status not in ('unresolved','resolved','unknown'):raise ValueError('问题状态无效')
                detail=db.execute('SELECT * FROM memory_summaries WHERE memory_id=?',(mid,)).fetchone()
                problem=data.get('problem',detail['problem']);user_state=data.get('user_state',detail['user_state'])
                if not isinstance(problem,str) or len(problem)>160:raise ValueError('问题主题无效')
                if not isinstance(user_state,str) or len(user_state)>400:raise ValueError('用户状态无效')
                db.execute('UPDATE memories SET text=?,updated=? WHERE id=?',(text,time.time(),mid))
                db.execute('UPDATE memory_summaries SET problem_status=?,problem=?,user_state=?,state_evidence=?,status_evidence=? WHERE memory_id=?',(problem_status,problem,user_state,'','',mid))
            elif action == 'delete':
                row = db.execute('SELECT owner FROM memories WHERE id=?',(data['id'],)).fetchone()
                if not row or row['owner'] != owner:
                    raise PermissionError('不能读取或删除其他用户记忆')
                db.execute('DELETE FROM memories WHERE id=? AND owner=?',(data['id'],owner))
                db.execute('DELETE FROM memory_summaries WHERE memory_id=?',(data['id'],))
                db.execute('DELETE FROM feedback WHERE owner=?',(owner,))
            elif action == 'clear':
                db.execute('DELETE FROM memory_summaries WHERE memory_id IN (SELECT id FROM memories WHERE owner=?)',(owner,))
                db.execute('DELETE FROM memories WHERE owner=?',(owner,))
                db.execute('DELETE FROM feedback WHERE owner=?',(owner,))
            elif action == 'feedback':
                gid, kind = data['guide_id'], data['kind']
                if gid not in self.entries or kind not in ('not_interested','done','ineffective','undo'):
                    raise ValueError('无效反馈')
                if not self.state(owner)['enabled']:
                    raise ValueError('记忆关闭时不保存长期反馈')
                if kind == 'undo':
                    db.execute('DELETE FROM feedback WHERE owner=? AND guide_id=?',(owner,gid))
                else:
                    db.execute('INSERT OR REPLACE INTO feedback VALUES (?,?,?)',(owner,gid,kind))
            else:
                raise ValueError('未知操作')
            db.execute('UPDATE profiles SET revision=revision+1 WHERE id=?',(owner,))
        return self.state(owner)

    def search(self, query, limit=8):
        # Chinese bigram lexical recall, deliberately a demo baseline rather than a claimed hybrid/rerank system.
        query = str(query)[:2000]
        tokens = set(re.findall(r'[A-Za-z0-9]{2,}',query.lower()))
        for part in re.findall(r'[\u4e00-\u9fff]+',query):
            tokens.update(part[i:i+2] for i in range(len(part)-1))
        stop={'怎么','什么','可以','时候','觉得','一个','这个','最近','自己','需要','问题','应该','每天','时间','工作','我的','现在','帮我','建议'}
        tokens -= stop
        scored = []
        for e in self.entries.values():
            title=e['title'].lower(); body=e['full_text'].lower()
            score=sum((6 if t in title else 1 if t in body else 0) for t in tokens)
            if score:
                scored.append((score,e))
        scored.sort(key=lambda item:(-item[0],item[1]['guide_id']))
        return [e for score,e in scored[:min(max(int(limit),1),12)]]

    def context(self, owner, query, mode, use_memory=True, followup_memory_id=''):
        with self.lock:
            now=time.time()
            self.runs={k:v for k,v in self.runs.items() if v['expires']>now}
            s=self.state(owner)
            memories=sorted(s['effective'],key=lambda m:m['updated'],reverse=True)[:12] if use_memory else []
            followup=next((m for m in memories if m['id']==followup_memory_id),None)
            if followup_memory_id and not followup:raise ValueError('回访记录已删除、停用或不属于当前用户')
            followups=[m for m in memories if m.get('origin')=='model_summary' and m.get('problem') and m.get('problem_status')!='resolved'][:3]
            rid=secrets.token_urlsafe(24)
            self.runs[rid]={'owner':owner,'revision':s['revision'],'reads':set(),'expires':now+600,
                            'memories':memories,'mode':mode,'query':query,'feedback':s['feedback'] if use_memory and s['enabled'] else [],
                            'memory_enabled':bool(use_memory and s['enabled']),'followup_memory_id':followup_memory_id,'followups':followups}
            cold=mode=='home' and not followups
            candidates=self.search(query,8) if mode=='chat' else []
            return {'run_id':rid,'memory_revision':s['revision'],'content_version':self.guide['content_version'],
                    'cold_start':cold,'personalization_applied':bool(memories),'memories':memories,
                    'query':query,'mode':mode,'feedback':self.runs[rid]['feedback'],
                    'memory_enabled':self.runs[rid]['memory_enabled'],'followup':followup,'followups':followups,
                    'candidate_titles':[{'guide_id':e['guide_id'],'title':e['title']} for e in candidates]}

    @staticmethod
    def model_json(raw):
        text=re.sub(r'<think>.*?</think>', '', str(raw).strip(), flags=re.DOTALL).strip()
        if text.startswith('```'):text=re.sub(r'^```(?:json)?\s*|\s*```$','',text)
        result=json.loads(text)
        if not isinstance(result,dict):raise ValueError('模型结果必须是 JSON 对象')
        return result

    def save_summary(self,owner,rid,raw):
        with self.lock:
            previous=self.runs.get(rid)
            if not previous or previous['owner']!=owner:raise PermissionError('请求归属不符')
            if previous.get('summary_saved_id'):
                exists=any(m['id']==previous['summary_saved_id'] for m in self.state(owner)['memories'])
                return {'saved':exists,'message':'本轮摘要已保存。' if exists else '本轮摘要已删除，不会自动恢复。','idempotent':True}
            run=self.run(rid)
            if run['mode']!='chat':raise ValueError('首页回访不能创建会话摘要')
            if not run['memory_enabled']:return {'saved':False,'message':'记忆已关闭，本轮不保存摘要。'}
            result=run.get('validated_result')
            if not result:raise ValueError('本轮答复未完成校验，不能保存摘要')
            data=self.model_json(raw)
            def short(key,limit,required=False):
                v=data.get(key,'')
                if not isinstance(v,str) or len(v)>limit or (required and not v.strip()):raise ValueError('摘要字段 '+key+' 无效')
                return v.strip()
            text=short('summary',800,True);user_state=short('user_state',400)
            problem=short('problem',160);problem_status=short('problem_status',20,True)
            if problem_status not in ('unresolved','resolved','unknown'):raise ValueError('问题状态无效')
            parent=short('followup_of',64)
            if run['followup_memory_id']:
                if parent and parent!=run['followup_memory_id']:raise ValueError('摘要关联了错误的回访问题')
                parent=run['followup_memory_id']
            related=next((m for m in run['memories'] if m['id']==parent and m.get('origin')=='model_summary'),None)
            if parent and not related:raise ValueError('摘要只能关联当前用户的有效会话记录')
            if not problem and related:problem=related['problem']
            if not problem and problem_status!='unknown':raise ValueError('没有具体问题时不能设置解决状态')
            evidence=short('state_evidence',1000);status_evidence=short('status_evidence',1000)
            if user_state and (not evidence or evidence not in run['query']):raise ValueError('用户状态缺少本轮明确表达的依据')
            if problem_status=='resolved':
                if not related or not status_evidence or status_evidence not in run['query']:raise ValueError('解决状态缺少本轮用户反馈')
                if re.search(r'(?:没|未|没有|尚未|还没).{0,4}(?:解决|搞定)|[?？]|解决了(?:吗|没有|没)|是否|不确定|不知道|如果|假如|可能|也许|希望',status_evidence) or not re.search(r'解决(?:了|啦|好)|搞定|处理好了|恢复正常|好了|没事了',status_evidence):
                    raise ValueError('未解决或询问进展不能标为已解决')
            elif related and related.get('problem_status')=='resolved' and not status_evidence:
                problem_status='resolved'
            guides=data.get('guide_ids',[])
            if not isinstance(guides,list) or len(guides)>12:raise ValueError('指南记录格式无效')
            available={c['guide_id'] for c in result['cards']}
            if related:available.update(related.get('guide_ids',[]))
            if any(not isinstance(g,str) or g not in available for g in guides):raise ValueError('摘要不能新增本轮未咨询过的指南')
            # Preserve exact consulted IDs independently of the model's textual summary.
            guides=sorted(available)
            mid=secrets.token_hex(12);now=time.time()
            with self.db() as db:
                if parent:db.execute('UPDATE memories SET state=? WHERE id=? AND owner=?',('superseded',parent,owner))
                db.execute('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?)',(mid,owner,'conversation_summary',text,now,now,'active',None))
                db.execute('INSERT INTO memory_summaries VALUES (?,?,?,?,?,?,?,?,?)',(mid,rid,user_state,problem,problem_status,json.dumps(guides),parent,evidence,status_evidence))
                db.execute('UPDATE profiles SET revision=revision+1 WHERE id=?',(owner,))
            run['summary_saved_id']=mid
            return {'saved':True,'message':'本轮会话摘要已自动保存。','memory_id':mid,'memory_revision':self.state(owner)['revision']}

    def finalize_home(self,owner,rid,raw):
        with self.lock:
            run=self.run(rid)
            if run['owner']!=owner:raise PermissionError('请求归属不符')
            if run['mode']!='home':raise ValueError('仅首页回访流程可调用')
            data=self.model_json(raw);chosen=data.get('followups',[])
            if not isinstance(chosen,list):raise ValueError('回访结果格式无效')
            candidates={m['id']:m for m in run['followups']};items=[];seen=set()
            for item in chosen[:3]:
                mid=item.get('memory_id')
                if mid not in candidates:raise ValueError('回访引用了无效或已解决的问题')
                if mid in seen:continue
                seen.add(mid);m=candidates[mid]
                guides=m.get('guides',[])
                items.append({'memory_id':mid,'topic':m['problem'],'last_discussed':m['updated'],
                              'progress_question':'上次你提到“'+m['problem']+'”，现在解决了吗？',
                              'guide_question':'还需要继续问“'+guides[0]['title']+'”等相关指南吗？' if guides else '还需要继续咨询相关指南吗？',
                              'guides':guides})
            result={'status':'followup' if items else 'empty','followups':items,'memory_revision':run['revision']}
            parts=[]
            for item in items:parts += [item['progress_question'],item['guide_question']]
            result['markdown']='\n\n'.join(parts) or '暂时没有需要跟进的问题，可以开始一次新提问。'
            return result

    def run(self,rid):
        with self.lock:
            run=self.runs.get(rid)
            if not run or run['expires']<time.time():
                raise ValueError('请求已到期，请重新执行')
            if self.state(run['owner'])['revision'] != run['revision']:
                raise ValueError('记忆已变更，旧结果已失效，请重新执行')
            return run

    def finalize(self, owner, rid, raw):
        with self.lock:
            run=self.run(rid)
            if run['owner'] != owner:
                raise PermissionError('请求归属不符')
            payload=self.model_json(raw)
            status=payload.get('status')
            if status not in ('answer','partial','unsupported','clarification','acknowledged'):
                raise ValueError('Agent 未返回约定结果状态')
            cards=[]; mids={m['id']:m for m in run['memories']}
            blocked={f['guide_id'] for f in run['feedback'] if f['kind'] in ('done','not_interested','ineffective')}
            for selected in payload.get('cards',[])[:3]:
                gid=selected['guide_id']
                if gid not in run['reads']:
                    raise ValueError('引用条目未完成本次全文回读')
                if gid in blocked or gid in {c['guide_id'] for c in cards}:
                    continue
                used=selected.get('memory_ids',[])
                if any(mid not in mids for mid in used):
                    raise ValueError('使用了无效或其他用户的记忆')
                entry=self.entries[gid]
                # No model-authored substantive suggestions are displayed: exact source fields are used.
                reason='参考以往会话摘要：'+'；'.join(mids[mid]['text'] for mid in used) if used else '与本次问题相关。'
                cards.append({**entry,'match_reason':reason,'memory_ids':used})
            if status in ('answer','partial') and not cards:
                status='unsupported'
            if status in ('unsupported','clarification','acknowledged'):
                cards=[]
            clarification=str(payload.get('clarification',''))[:300] if status=='clarification' else ''
            if status=='clarification' and not clarification:
                raise ValueError('澄清结果缺少问题')
            result={'status':status,'cards':cards,'clarification':clarification,
                    'memory_revision':run['revision'],'personalization_applied':bool(run['memories']),
                    'content_version':self.guide['content_version'],
                    'message':{'answer':'找到以下指南条目，请结合适用限制选择。','partial':'目前只找到部分支持；下列条目仅回答有依据的部分，其余暂不补充。','unsupported':'目前未找到足够的适用指南支持，可补充或重新表达。','clarification':clarification,'acknowledged':'了解你的进展了。需要继续咨询时，可以随时提问。'}[status]}
            result['markdown']=self.markdown(result)
            run['validated_result']=result
            return result

    @staticmethod
    def markdown(result):
        # Escape brackets/angle brackets in user text. Links use fixed upstream URLs, not model links.
        def safe(x): return str(x).replace('<','&lt;').replace('>','&gt;').replace('[','\\[').replace(']','\\]')
        parts=[safe(result['message'])]
        for card in result['cards']:
            f=card['fields']
            parts += ['\n### '+safe(card['title']),safe(card['match_reason']),
                      '**指南原文摘要：** '+safe(f.get('说人话','见完整条目')),
                      '**成本：** '+safe(f.get('成本','原文未提供')),
                      '**证据等级：** '+safe(f.get('证据等级','原文未提供')),
                      '**限制与备注：** '+safe(f.get('备注','原文未提供')),
                      '['+card['source_locator']+']('+card['source_url']+') · '+card['guide_id']]
        return '\n\n'.join(parts)

