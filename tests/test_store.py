import pytest
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from backend.store import Store


class MemoryAndGuideTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.s=Store(self.temp.name)
        self.s.change('alice','settings',{'enabled':True})
        self.s.change('alice','save',{'kind':'concern','text':'工作时被手机通知打断','confirmed':True})
    def tearDown(self):self.temp.cleanup()
    def payload(self,run,ids=None):
        return json.dumps({'status':'answer','cards':[{'guide_id':'03-01','memory_ids':ids or []}]})
    def read(self,run):self.s.runs[run]['reads'].add('03-01')
    def test_real_full_entries(self):
        self.assertEqual(len(self.s.entries),687)
        for e in self.s.entries.values():
            self.assertTrue(e['complete'])
            self.assertIn('来源',e['fields'])
            self.assertIn('备注',e['fields'])
    def test_search_notifications(self):self.assertIn('03-01',[e['guide_id'] for e in self.s.search('手机通知打断工作')])
    def test_unconfirmed_memory_is_rejected(self):
        with self.assertRaises(ValueError):self.s.change('alice','save',{'text':'不要自动记住','confirmed':False})
    def test_cross_session_and_persistence(self):
        other=Store(self.temp.name)
        self.assertEqual(other.state('alice')['effective'][0]['text'],'工作时被手机通知打断')
        self.assertTrue(other.context('alice','新的问题','chat')['memories'])
    def test_user_isolation(self):
        self.assertFalse(self.s.state('bob')['effective'])
        mid=self.s.state('alice')['memories'][0]['id']
        with self.assertRaises(PermissionError):self.s.change('bob','delete',{'id':mid})
    def test_finalization_requires_full_read(self):
        rid=self.s.context('alice','手机通知','chat')['run_id']
        with self.assertRaises(ValueError):self.s.finalize('alice',rid,self.payload(rid))
    def test_invalid_memory_reference_rejected(self):
        rid=self.s.context('alice','手机通知','chat')['run_id'];self.read(rid)
        with self.assertRaises(ValueError):self.s.finalize('alice',rid,self.payload(rid,['invented']))
    def test_deleted_memory_invalidates_inflight(self):
        rid=self.s.context('alice','手机通知','chat')['run_id'];self.read(rid)
        mid=self.s.state('alice')['memories'][0]['id'];self.s.change('alice','delete',{'id':mid})
        with self.assertRaises(ValueError):self.s.finalize('alice',rid,self.payload(rid))
        self.assertFalse(self.s.context('alice','新问题','chat')['memories'])
    def test_disable_retains_management_but_stops_personalization(self):
        self.s.change('alice','settings',{'enabled':False})
        self.assertTrue(self.s.state('alice')['memories'])
        self.assertFalse(self.s.context('alice','','home')['memories'])
        self.assertTrue(self.s.context('alice','','home')['cold_start'])
    def test_feedback_and_undo(self):
        self.s.change('alice','feedback',{'guide_id':'03-01','kind':'not_interested'})
        rid=self.s.context('alice','手机通知','home')['run_id'];self.read(rid)
        self.assertFalse(self.s.finalize('alice',rid,self.payload(rid))['cards'])
        self.s.change('alice','feedback',{'guide_id':'03-01','kind':'undo'})
        self.assertFalse(self.s.state('alice')['feedback'])
    def test_model_cannot_inject_advice_fields(self):
        rid=self.s.context('alice','手机通知','chat')['run_id'];self.read(rid)
        raw=json.dumps({'status':'answer','cards':[{'guide_id':'03-01','memory_ids':[]}],'summary':'伪造收益保证','advice':'注入任意内容'})
        result=self.s.finalize('alice',rid,raw)
        self.assertNotIn('伪造收益保证',result['markdown'])
        self.assertNotIn('注入任意内容',result['markdown'])
        self.assertEqual(result['cards'][0]['fields'],self.s.entries['03-01']['fields'])
    def test_finalization_owner(self):
        rid=self.s.context('alice','手机通知','chat')['run_id'];self.read(rid)
        with self.assertRaises(PermissionError):self.s.finalize('bob',rid,self.payload(rid))
    def test_deepseek_reasoning_blocks_are_not_displayed(self):
        rid=self.s.context('alice','手机通知','chat')['run_id'];self.read(rid)
        raw='<think>内部分析</think>\n<think>第二轮分析</think>\n```json\n'+self.payload(rid)+'\n```'
        result=self.s.finalize('alice',rid,raw)
        self.assertEqual(result['status'],'answer')
        self.assertNotIn('内部分析',result['markdown'])
    def summary_turn(self,query='工作时被手机通知打断',parent='',status='unresolved',raw_overrides=None):
        rid=self.s.context('alice',query,'chat',followup_memory_id=parent)['run_id'];self.read(rid)
        self.s.finalize('alice',rid,self.payload(rid))
        data={'summary':'用户咨询工作时被通知打断的问题，寻求相关指南。','user_state':query,
              'state_evidence':query,'problem':'工作时被手机通知打断','problem_status':status,
              'status_evidence':query if parent else '', 'followup_of':parent,'guide_ids':['03-01']}
        if raw_overrides:data.update(raw_overrides)
        return rid,self.s.save_summary('alice',rid,json.dumps(data))
    def test_automatic_summary_saved_without_confirmation(self):
        rid,result=self.summary_turn();self.assertTrue(result['saved'])
        m=self.s.state('alice')['memories'][-1]
        self.assertEqual(m['origin'],'model_summary');self.assertEqual(m['guide_ids'],['03-01'])
        self.assertEqual(Store(self.temp.name).state('alice')['memories'][-1]['problem_status'],'unresolved')
        self.assertTrue(self.s.save_summary('alice',rid,'{}')['idempotent'])
    def test_deleted_summary_is_not_recreated_on_retry(self):
        rid,result=self.summary_turn();self.s.change('alice','delete',{'id':result['memory_id']})
        self.assertFalse(self.s.save_summary('alice',rid,'{}')['saved'])
    def test_summary_rejects_invented_state_or_guide(self):
        with self.assertRaises(ValueError):self.summary_turn(raw_overrides={'state_evidence':'用户从未说过'})
        with self.assertRaises(ValueError):self.summary_turn(raw_overrides={'guide_ids':['01-01']})
    def test_new_answer_does_not_mean_problem_resolved(self):
        with self.assertRaises(ValueError):self.summary_turn(status='resolved')
    def test_negative_progress_cannot_be_marked_resolved(self):
        _,saved=self.summary_turn()
        with self.assertRaises(ValueError):self.summary_turn('这个问题还没解决',saved['memory_id'],'resolved')
    def test_uncertain_progress_cannot_be_marked_resolved(self):
        _,saved=self.summary_turn()
        with self.assertRaises(ValueError):self.summary_turn('不知道这个问题是否解决了',saved['memory_id'],'resolved')

    def test_followup_only_asks_questions_and_resolved_stops(self):
        _,saved=self.summary_turn();mid=saved['memory_id']
        context=self.s.context('alice','','home')
        result=self.s.finalize_home('alice',context['run_id'],json.dumps({'followups':[{'memory_id':mid}],'advice':'伪造指南内容'}))
        self.assertIn('现在解决了吗',result['markdown']);self.assertIn('还需要继续问',result['markdown'])
        self.assertNotIn('伪造指南内容',result['markdown']);self.assertNotIn('成本',result['markdown'])
        self.summary_turn('这个问题已经解决了',mid,'resolved')
        self.assertTrue(self.s.context('alice','','home')['cold_start'])
        self.assertEqual(len(self.s.state('alice')['memories']),3)
    def test_unresolved_followup_updates_same_problem(self):
        _,saved=self.summary_turn();mid=saved['memory_id']
        _,new=self.summary_turn('这个问题还没解决',mid,'unresolved')
        home=self.s.context('alice','','home')
        self.assertEqual([m['id'] for m in home['followups']],[new['memory_id']])
        self.assertEqual(self.s.state('alice')['memories'][1]['state'],'superseded')
    def test_home_cannot_save_memory_and_wrong_owner_rejected(self):
        _,saved=self.summary_turn();context=self.s.context('alice','','home')
        with self.assertRaises(ValueError):self.s.save_summary('alice',context['run_id'],'{}')
        with self.assertRaises(PermissionError):self.s.save_summary('bob',context['run_id'],'{}')
        other=self.s.context('bob','','home')
        with self.assertRaises(ValueError):self.s.finalize_home('bob',other['run_id'],json.dumps({'followups':[{'memory_id':saved['memory_id']}]}))
    def test_summary_disabled_or_memory_changed_during_generation(self):
        self.s.change('alice','settings',{'enabled':False})
        rid=self.s.context('alice','手机通知','chat')['run_id'];self.read(rid)
        self.s.finalize('alice',rid,self.payload(rid))
        self.assertFalse(self.s.save_summary('alice',rid,'{}')['saved'])
        self.s.change('alice','settings',{'enabled':True})
        rid=self.s.context('alice','手机通知','chat')['run_id'];self.read(rid)
        self.s.finalize('alice',rid,self.payload(rid));self.s.change('alice','clear',{})
        with self.assertRaises(ValueError):self.s.save_summary('alice',rid,'{}')
    def test_correct_summary_updates_home_topic(self):
        _,saved=self.summary_turn();mid=saved['memory_id']
        self.s.change('alice','correct_summary',{'id':mid,'text':'用户纠正了问题主题','problem':'消息打断专注','user_state':'工作专注','problem_status':'unresolved'})
        home=self.s.context('alice','','home')
        self.assertEqual(home['followups'][0]['problem'],'消息打断专注')
    def test_greeting_summary_does_not_create_followup_problem(self):
        rid=self.s.context('alice','你好','chat')['run_id']
        self.s.finalize('alice',rid,json.dumps({'status':'acknowledged','cards':[]}))
        raw={'summary':'用户打招呼，未提出具体困扰。','user_state':'','state_evidence':'','problem':'','problem_status':'unknown','status_evidence':'','followup_of':'','guide_ids':[]}
        self.assertTrue(self.s.save_summary('alice',rid,json.dumps(raw))['saved'])
        self.assertTrue(self.s.context('alice','','home')['cold_start'])


if __name__=='__main__':unittest.main()


def test_explicit_active_followup_is_not_lost_outside_recent_memory_window(tmp_path):
    store = Store(tmp_path)
    store.change('alice', 'settings', {'enabled': True})
    first = store.change('alice', 'save', {'confirmed': True, 'text': '需要继续跟进的早期问题'})['effective'][0]['id']
    for index in range(13):
        store.change('alice', 'save', {'confirmed': True, 'text': f'较新的其他记录 {index}'})
    context = store.context('alice', '继续旧问题', 'chat', followup_memory_id=first)
    assert len(context['memories']) == 12
    assert context['followup']['id'] == context['memories'][0]['id'] == first


def test_inflight_result_cannot_use_fact_that_expired_after_context_creation(tmp_path, monkeypatch):
    store = Store(tmp_path)
    store.change('alice', 'settings', {'enabled': True})
    import time
    now = time.time()
    store.change('alice', 'save', {'confirmed': True, 'text': '仅暂时有效的合成事实', 'expires': now + 10})
    context = store.context('alice', '你好', 'chat')
    monkeypatch.setattr('backend.store.time.time', lambda: now + 11)
    with pytest.raises(ValueError, match='记忆已到期'):
        store.run(context['run_id'])
