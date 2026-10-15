"use strict";
// All user/model text is rendered with textContent; no model HTML is executed.
const Evals = (() => {
  const stages = {
    understanding: "理解问题",
    retrieval: "检索指南",
    reply: "组织回复",
    memory: "提取记忆",
    summary: "生成摘要",
    overall: "整体输入输出",
  };
  const verdicts = { pass: "通过", fail: "失败", pending: "待确认" };
  const jobStates = {
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    cancelled: "已取消",
    interrupted: "已中断",
  };
  const kinds = {
    chat: "用户提问",
    new_conversation: "另开会话（保留长期记忆）",
    home: "首页回访",
    memory: "管理测试记忆",
  };
  let user = null,
    version = 0,
    catalog = null,
    datasets = [],
    dataset = null,
    selection = new Set(),
    editing = null,
    currentJob = null,
    timer = null,
    module = "understanding",
    loadedVersion = null;
  const q = (id) => document.getElementById(id);
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const append = (parent, tag, text, cls) => {
    const n = el(tag, text, cls);
    parent.append(n);
    return n;
  };
  const button = (parent, text, action, cls) => {
    const n = append(parent, "button", text, cls);
    n.type = "button";
    n.onclick = () => guard(action, n);
    return n;
  };
  const note = (text) => {
    q("ev-status").textContent = text;
  };
  async function scopedApi(path, data) {
    const token = version;
    const result = await api(path, data);
    if (token !== version) throw Error("账号已变更，请重新操作。");
    return result;
  }
  async function guard(action, control) {
    const token = version;
    if (control) control.disabled = true;
    try {
      await action();
    } catch (e) {
      if (token === version) note(e.message);
    } finally {
      if (control?.isConnected) control.disabled = false;
    }
  }
  function field(parent, title, id, value = "", tag = "input") {
    const label = append(parent, "label", title);
    label.htmlFor = id;
    const input = append(parent, tag);
    input.id = id;
    input.value = value;
    return input;
  }
  function select(parent, title, id, options, value) {
    const n = field(parent, title, id, "", "select");
    for (const [val, label] of options) {
      const o = el("option", label);
      o.value = val;
      n.append(o);
    }
    if (value !== undefined) n.value = value;
    return n;
  }
  function json(parent, title, value, open = false) {
    const d = append(parent, "details");
    d.open = open;
    append(d, "summary", title);
    append(
      d,
      "pre",
      typeof value === "string" ? value : JSON.stringify(value, null, 2),
    );
    return d;
  }
  function download(name, value, type = "application/json") {
    const url = URL.createObjectURL(
      new Blob(
        [typeof value === "string" ? value : JSON.stringify(value, null, 2)],
        { type },
      ),
    );
    const a = el("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function choices() {
    return catalog.bundles.map((b) => [
      b.id,
      b.name +
        " · " +
        b.id.slice(0, 6) +
        (b.id === catalog.active_bundle_id ? " · 产品当前启用" : ""),
    ]);
  }
  function tab(name) {
    for (const panel of document.querySelectorAll("[data-bench-panel]"))
      panel.hidden = panel.dataset.benchPanel !== name;
    for (const b of document.querySelectorAll("[data-bench-tab]"))
      b.setAttribute("aria-selected", String(b.dataset.benchTab === name));
  }
  function stop() {
    user = null;
    version++;
    clearTimeout(timer);
    timer = null;
    currentJob = null;
    dataset = null;
    selection.clear();
    for (const id of ["ev-dataset", "ev-jobs", "ev-prompt"])
      q(id)?.replaceChildren();
  }
  async function enter(account) {
    const token = ++version;
    user = account;
    const values = await Promise.all([
      scopedApi("/api/prompts"),
      scopedApi("/api/eval/datasets"),
    ]);
    if (token !== version) return;
    catalog = values[0];
    datasets = values[1].datasets;
    makeTabs();
    await showDatasets();
    await showJobs();
    await showPrompts();
    populateFree();
  }
  function makeTabs() {
    const nav = q("bench-tabs");
    nav.replaceChildren();
    for (const [key, label] of [
      ["dataset", "评测集"],
      ["jobs", "批量运行与结果"],
      ["prompt", "提示词管理"],
      ["free", "自由测试"],
    ]) {
      const b = button(nav, label, () => tab(key));
      b.dataset.benchTab = key;
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", "false");
    }
    tab("dataset");
    note("评测集和提示词为团队共享；运行结果与测试记忆仅当前账号可见。");
  }
  function populateFree() {
    const box = q("free-prompt");
    box.replaceChildren();
    select(
      box,
      "自由测试使用的提示词组合",
      "free-bundle",
      choices(),
      catalog.active_bundle_id,
    ).onchange = () => {
      sessions = {};
      controls();
      message("提示词组合已更换，下一次自由测试创建新会话。");
    };
  }
  async function refreshLibrary() {
    catalog = await scopedApi("/api/prompts");
    datasets = (await scopedApi("/api/eval/datasets")).datasets;
  }
  async function loadDataset(id, revision) {
    dataset = await scopedApi(
      "/api/eval/datasets/" + id + (revision ? "?version=" + revision : ""),
    );
    selection = new Set(dataset.cases.map((c) => c.id));
    editing = null;
    await showDatasets(false);
  }
  async function showDatasets(load = true) {
    const panel = q("ev-dataset");
    panel.replaceChildren();
    const grid = append(panel, "div", undefined, "bench-grid");
    const left = append(grid, "section");
    append(left, "h2", "评测集");
    const list = append(left, "aside");
    for (const d of datasets) {
      const b = button(
        list,
        d.name,
        () => loadDataset(d.id),
        "library-item" + (dataset?.id === d.id ? " active" : ""),
      );
      append(b, "small", "v" + d.current + " · " + d.author);
    }
    button(left, "新建评测集", () => {
      dataset = { name: "", description: "", cases: [] };
      selection.clear();
      showDatasets(false);
    });
    const file = field(left, "导入 JSON 评测集", "ev-import-set", "", "input");
    file.type = "file";
    file.accept = ".json,application/json";
    file.onchange = () =>
      guard(async () => {
        const f = file.files[0];
        if (!f) return;
        if (f.size > 2000000) throw Error("文件最大 2 MB。");
        const data = JSON.parse(await f.text());
        delete data.id;
        delete data.expected_version;
        dataset = await scopedApi("/api/eval/datasets", data);
        await refreshLibrary();
        selection = new Set(dataset.cases.map((c) => c.id));
        await showDatasets(false);
        note("已导入为新评测集，原评测集保留。");
      });
    const content = append(grid, "section");
    if (load && !dataset && datasets.length) {
      await loadDataset(datasets[0].id);
      return;
    }
    if (!dataset) {
      append(content, "p", "新建或导入评测集。", "empty");
      return;
    }
    append(
      content,
      "h2",
      dataset.id ? dataset.name + " · v" + dataset.version : "新建评测集",
    );
    field(content, "名称", "ev-ds-name", dataset.name).maxLength = 120;
    field(
      content,
      "说明",
      "ev-ds-description",
      dataset.description,
      "textarea",
    ).maxLength = 2000;
    const actions = append(content, "div", undefined, "form-actions");
    button(
      actions,
      "保存评测集",
      async () => {
        dataset = await saveDataset();
        await refreshLibrary();
        await showDatasets(false);
        note("已保存不可变版本 v" + dataset.version + "。");
      },
      "primary",
    );
    if (dataset.id) {
      button(actions, "导出本版本 JSON", () =>
        download("lifeos-dataset-v" + dataset.version + ".json", {
          name: dataset.name,
          description: dataset.description,
          cases: dataset.cases,
        }),
      );
      button(actions, "归档评测集", async () => {
        await scopedApi("/api/eval/archive", {
          id: dataset.id,
          expected_version: dataset.current,
        });
        dataset = null;
        await refreshLibrary();
        await showDatasets();
        note("已归档；已有版本和运行记录保留。");
      });
      const history = select(
        content,
        "查看历史版本（可恢复后另存新版本）",
        "ev-ds-version",
        dataset.history.map((v) => [
          String(v.version),
          "v" + v.version + " · " + v.author,
        ]),
        String(dataset.version),
      );
      history.onchange = () =>
        guard(() => loadDataset(dataset.id, Number(history.value)));
    }
    const toolbar = append(content, "div", undefined, "panel-toolbar");
    button(toolbar, "添加用例", () => editCase(null));
    button(toolbar, "全选", () => {
      selection = new Set(dataset.cases.map((c) => c.id));
      renderCases();
    });
    button(toolbar, "全不选", () => {
      selection.clear();
      renderCases();
    });
    const filter = field(toolbar, "按名称或分类筛选", "ev-filter", "");
    filter.oninput = renderCases;
    const runActions = append(content, "div", undefined, "row");
    button(
      runActions,
      "用所选用例配置批量测试",
      async () => {
        if (!dataset.id) throw Error("请先保存评测集。");
        if (!selection.size) throw Error("至少选择一个用例。");
        await showJobs();
        tab("jobs");
        note("已选择 " + selection.size + " 个用例；请选择执行方案。");
      },
      "primary",
    );
    append(
      content,
      "small",
      "支持单轮、多轮和跨会话记忆。每个用例独立存储；步骤以内可保留会话或长期记忆。历史版本恢复后保存会产生新版本。",
    );
    append(content, "div").id = "ev-cases";
    append(content, "div").id = "ev-case-editor";
    renderCases();
  }
  async function saveDataset(cases = dataset.cases) {
    return scopedApi("/api/eval/datasets", {
      ...(dataset.id
        ? { id: dataset.id, expected_version: dataset.current }
        : {}),
      name: q("ev-ds-name").value,
      description: q("ev-ds-description").value,
      cases,
    });
  }
  function renderCases() {
    const list = q("ev-cases");
    list.replaceChildren();
    const filter = (q("ev-filter")?.value || "").trim().toLowerCase();
    for (const c of dataset.cases) {
      if (
        filter &&
        !JSON.stringify([c.title, c.tags]).toLowerCase().includes(filter)
      )
        continue;
      const row = append(list, "div", undefined, "case-row");
      const label = append(row, "label", undefined, "row");
      const checkbox = append(label, "input");
      checkbox.type = "checkbox";
      checkbox.checked = selection.has(c.id);
      checkbox.setAttribute("aria-label", "选择 " + c.title);
      checkbox.onchange = () =>
        checkbox.checked ? selection.add(c.id) : selection.delete(c.id);
      append(label, "strong", c.title);
      append(
        row,
        "small",
        c.steps.length +
          " 步 · " +
          (c.tags.join(" / ") || "未分类") +
          " · " +
          (c.memory_enabled ? "开启记忆" : "关闭记忆"),
      );
      const buttons = append(row, "div", undefined, "row");
      button(buttons, "编辑", () => editCase(c));
      button(buttons, "复制", () => {
        const copy = structuredClone(c);
        copy.id = crypto.randomUUID();
        copy.title += "（副本）";
        editCase(copy);
      });
      button(buttons, "删除用例", async () => {
        dataset = await saveDataset(dataset.cases.filter((x) => x.id !== c.id));
        selection.delete(c.id);
        await refreshLibrary();
        await showDatasets(false);
        note("已生成新版本，历史中的用例仍可恢复。");
      });
    }
    if (!list.children.length) append(list, "p", "没有匹配用例。", "empty");
  }
  function editCase(source) {
    editing = source
      ? structuredClone(source)
      : {
          id: crypto.randomUUID(),
          title: "",
          tags: [],
          memory_enabled: true,
          steps: [{ kind: "chat", query: "" }],
          criteria: {},
          rules: [],
          reference_answer: "",
        };
    const box = q("ev-case-editor");
    box.replaceChildren();
    append(box, "h2", source ? "编辑用例" : "新建用例");
    field(box, "用例名称", "ev-case-title", editing.title).maxLength = 120;
    field(box, "分类标签（逗号分隔）", "ev-case-tags", editing.tags.join(", "));
    const label = append(box, "label", undefined, "row");
    const mem = append(label, "input");
    mem.type = "checkbox";
    mem.id = "ev-case-memory";
    mem.checked = editing.memory_enabled;
    append(label, "span", "本用例开启长期记忆");
    append(box, "div").id = "ev-steps";
    renderSteps();
    button(box, "添加步骤", () => {
      collectSteps();
      if (editing.steps.length >= 20) throw Error("每个用例最多 20 步。");
      editing.steps.push({ kind: "chat", query: "" });
      renderSteps();
    });
    append(
      box,
      "p",
      "填写“必须满足”和“禁止发生”的条件；空白环节保持待确认。整体输入输出独立判定。",
      "muted",
    );
    const standards = append(box, "div", undefined, "stage-grid");
    for (const [key, name] of Object.entries(stages)) {
      const f = append(standards, "fieldset");
      append(f, "legend", name);
      field(
        f,
        "判定条件（必须满足 / 禁止发生）",
        "ev-criterion-" + key,
        editing.criteria[key] || "",
        "textarea",
      ).maxLength = 2000;
    }
    field(
      box,
      "参考答案（可选，不要求逐字一致）",
      "ev-reference",
      editing.reference_answer,
      "textarea",
    ).maxLength = 5000;
    const advanced = append(box, "details");
    append(advanced, "summary", "确定性规则（高级选项）");
    append(
      advanced,
      "small",
      "step 从 1 开始；stage 为六环节标识；类型包括 status、contains、not_contains、guide_include、guide_exclude、tool_called、memory_contains、memory_not_contains、summary_saved、followup_count。",
    );
    field(
      advanced,
      "规则 JSON",
      "ev-rules",
      JSON.stringify(editing.rules, null, 2),
      "textarea",
    ).className = "code";
    const actions = append(box, "div", undefined, "form-actions");
    button(
      actions,
      "保存用例并生成评测集版本",
      async () => {
        collectSteps();
        editing.title = q("ev-case-title").value;
        editing.tags = q("ev-case-tags")
          .value.split(/[,，]/)
          .map((v) => v.trim())
          .filter(Boolean);
        editing.memory_enabled = q("ev-case-memory").checked;
        editing.criteria = Object.fromEntries(
          Object.keys(stages).map((k) => [k, q("ev-criterion-" + k).value]),
        );
        editing.reference_answer = q("ev-reference").value;
        editing.rules = JSON.parse(q("ev-rules").value);
        const cases = dataset.cases.filter((c) => c.id !== editing.id);
        cases.push(editing);
        dataset = await saveDataset(cases);
        selection.add(editing.id);
        editing = null;
        await refreshLibrary();
        await showDatasets(false);
        note("用例已保存到评测集 v" + dataset.version + "。");
      },
      "primary",
    );
    button(actions, "取消编辑", () => {
      editing = null;
      box.replaceChildren();
    });
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderSteps() {
    const list = q("ev-steps");
    list.replaceChildren();
    editing.steps.forEach((step, i) => {
      const row = append(list, "div", undefined, "step-editor");
      append(row, "strong", "步骤 " + (i + 1));
      const kind = select(
        row,
        "步骤类型",
        "ev-kind-" + i,
        Object.entries(kinds),
        step.kind,
      );
      kind.onchange = () => {
        collectSteps();
        const changed = kind.value;
        editing.steps[i] = {
          kind: changed,
          ...(changed === "chat"
            ? { query: "" }
            : changed === "memory"
              ? { action: "clear", data: {} }
              : {}),
        };
        renderSteps();
      };
      if (step.kind === "chat")
        field(
          row,
          "用户输入",
          "ev-step-query-" + i,
          step.query || "",
          "textarea",
        ).maxLength = 2000;
      if (step.kind === "memory") {
        const action = select(
          row,
          "记忆操作",
          "ev-action-" + i,
          [
            ["clear", "清空本用例记忆"],
            ["delete_last", "删除最近有效摘要"],
            ["correct_last", "纠正最近有效摘要"],
            ["settings", "修改记忆开关"],
          ],
          step.action,
        );
        action.onchange = () => {
          collectSteps();
          editing.steps[i].action = action.value;
          editing.steps[i].data = {};
          renderSteps();
        };
        if (step.action === "correct_last") {
          field(
            row,
            "纠正后的摘要",
            "ev-correct-" + i,
            step.data?.text || "",
            "textarea",
          );
          select(
            row,
            "问题状态",
            "ev-correct-status-" + i,
            [
              ["unknown", "未知"],
              ["unresolved", "未解决"],
              ["resolved", "已解决"],
            ],
            step.data?.problem_status || "unknown",
          );
        }
        if (step.action === "settings")
          select(
            row,
            "记忆开关",
            "ev-enabled-" + i,
            [
              ["true", "开启"],
              ["false", "关闭"],
            ],
            String(step.data?.enabled ?? true),
          );
      }
      const moves = append(row, "div", undefined, "row");
      button(moves, "上移", () => {
        collectSteps();
        if (i) {
          [editing.steps[i - 1], editing.steps[i]] = [
            editing.steps[i],
            editing.steps[i - 1],
          ];
          renderSteps();
        }
      });
      button(moves, "下移", () => {
        collectSteps();
        if (i < editing.steps.length - 1) {
          [editing.steps[i + 1], editing.steps[i]] = [
            editing.steps[i],
            editing.steps[i + 1],
          ];
          renderSteps();
        }
      });
      button(moves, "移除", () => {
        collectSteps();
        editing.steps.splice(i, 1);
        renderSteps();
      });
    });
  }
  function collectSteps() {
    editing.steps.forEach((s, i) => {
      if (s.kind === "chat" && q("ev-step-query-" + i))
        s.query = q("ev-step-query-" + i).value;
      if (s.kind === "memory") {
        if (s.action === "correct_last" && q("ev-correct-" + i))
          s.data = {
            text: q("ev-correct-" + i).value,
            problem_status: q("ev-correct-status-" + i).value,
          };
        if (s.action === "settings" && q("ev-enabled-" + i))
          s.data = { enabled: q("ev-enabled-" + i).value === "true" };
      }
    });
  }
  async function showJobs() {
    const panel = q("ev-jobs");
    panel.replaceChildren();
    const setup = append(panel, "section");
    append(setup, "h2", "批量运行");
    const ds = select(
      setup,
      "评测集",
      "ev-run-dataset",
      datasets.map((d) => [d.id, d.name + " · v" + d.current]),
      dataset?.id,
    );
    ds.onchange = () =>
      guard(async () => {
        await loadDataset(ds.value);
        await showJobs();
        tab("jobs");
      });
    append(
      setup,
      "p",
      "当前选择 " +
        selection.size +
        " 个用例 · 版本 " +
        (dataset?.version || "—") +
        "。到评测集页可筛选与勾选用例。",
      "muted",
    );
    const variants = append(setup, "div", undefined, "split");
    for (const v of ["A", "B"]) {
      const f = append(variants, "fieldset");
      append(f, "legend", "方案 " + v);
      append(f, "p", "统一使用 Claude Agent SDK", "muted");
      select(
        f,
        "提示词组合",
        "ev-bundle-" + v,
        choices(),
        catalog.active_bundle_id,
      );
    }
    const compareLabel = append(setup, "label", undefined, "row");
    const compare = append(compareLabel, "input");
    compare.type = "checkbox";
    compare.id = "ev-compare";
    append(compareLabel, "span", "同时运行 A / B，按同一用例并排比较");
    select(
      setup,
      "固定评测判定提示词版本（A/B 共用）",
      "ev-judge",
      catalog.versions
        .filter((v) => v.module === "judge")
        .map((v) => [v.id, v.note + " · " + v.hash.slice(0, 8)]),
      catalog.bundles.find((b) => b.id === catalog.active_bundle_id).versions
        .judge,
    );
    append(
      setup,
      "small",
      "每个方案、每个用例各用独立测试记忆；同用例各步骤可以连续交流。任务排队执行，系统判定后由测试者复核。A/B 比较两份提示词方案，两者均使用 SDK，请尽量一次只改一个模块。",
    );
    button(
      append(setup, "div", undefined, "row"),
      "开始批量评测",
      async () => {
        if (!dataset?.id || !selection.size)
          throw Error("请先选择评测集及用例。");
        const variants = ["A", ...(q("ev-compare").checked ? ["B"] : [])].map(
          (v) => ({
            runtime: "claude-sdk",
            bundle_id: q("ev-bundle-" + v).value,
          }),
        );
        const job = await scopedApi("/api/eval/jobs", {
          dataset_id: dataset.id,
          dataset_version: dataset.version,
          case_ids: [...selection],
          variants,
          judge_version_id: q("ev-judge").value,
        });
        await loadJobs();
        await openJob(job.id);
        note("任务已提交。可以离开页面，后台继续运行。");
      },
      "primary",
    );
    const recent = append(panel, "section");
    const bar = append(recent, "div", undefined, "row");
    append(bar, "h2", "我的批量任务");
    button(bar, "刷新任务", loadJobs);
    append(recent, "div").id = "ev-job-list";
    append(panel, "section").id = "ev-job-details";
    await loadJobs();
    if (currentJob) await openJob(currentJob);
  }
  async function loadJobs() {
    const token = version;
    const data = await scopedApi("/api/eval/jobs");
    if (token !== version) return;
    const list = q("ev-job-list");
    if (!list) return;
    list.replaceChildren();
    for (const job of data.jobs) {
      const row = append(list, "div", undefined, "job-row");
      append(row, "strong", job.dataset_name + " · v" + job.dataset_version);
      append(
        row,
        "p",
        new Date(job.created * 1000).toLocaleString() +
          " · " +
          jobStates[job.status] +
          " · " +
          job.completed +
          "/" +
          job.total,
      );
      for (const v of job.variants) {
        const c = job.counts[v.label];
        append(
          row,
          "small",
          v.label +
            " " +
            labels[v.runtime] +
            " · 系统：" +
            c.pass +
            " 通过 / " +
            c.fail +
            " 失败 / " +
            c.pending +
            " 待确认",
        );
        append(row, "br");
      }
      button(row, "查看任务与对比", () => openJob(job.id));
    }
    if (!data.jobs.length) append(list, "p", "还没有批量任务。", "empty");
  }
  async function openJob(id) {
    clearTimeout(timer);
    currentJob = id;
    const token = version;
    const job = await scopedApi("/api/eval/jobs/" + id);
    if (token !== version || currentJob !== id) return;
    renderJob(job);
    if (["queued", "running"].includes(job.status))
      timer = setTimeout(() => {
        if (user && currentJob === id) guard(() => openJob(id));
      }, 2000);
    else await loadJobs();
  }
  function renderJob(job) {
    const box = q("ev-job-details");
    if (!box) return;
    const selectedFilter = q("ev-result-filter")?.value || "all";
    const opened = box.dataset.job === job.id;
    box.dataset.job = job.id;
    let detail = box.querySelector("#ev-result-details");
    if (!opened) detail = null;
    const retained = detail;
    box.replaceChildren();
    append(
      box,
      "h2",
      job.dataset_name +
        " · v" +
        job.dataset_version +
        " · " +
        jobStates[job.status],
    );
    append(
      box,
      "p",
      job.completed +
        "/" +
        job.total +
        " 个方案结果已完成" +
        (job.message ? " · " + job.message : ""),
    );
    for (const v of job.variants) {
      const c = job.counts[v.label],
        r = job.review_counts[v.label];
      append(
        box,
        "div",
        "方案 " +
          v.label +
          " · " +
          labels[v.runtime] +
          " · " +
          v.bundle_name +
          "\n系统：" +
          c.pass +
          " 通过 / " +
          c.fail +
          " 失败 / " +
          c.pending +
          " 待确认\n复核：" +
          r.pass +
          " 通过 / " +
          r.fail +
          " 失败 / " +
          r.pending +
          " 待确认 / " +
          r.unreviewed +
          " 未复核",
        "stat-line",
      );
    }
    const actions = append(box, "div", undefined, "row");
    if (["running", "queued"].includes(job.status))
      button(actions, "取消任务", async () => {
        await scopedApi("/api/eval/jobs/" + job.id + "/cancel", {});
        note("已请求取消，当前用例结束后停止；已有结果保留。");
        await openJob(job.id);
      });
    else if (job.variants.every((v) => v.runtime === "claude-sdk")) {
      button(actions, "按原快照全部重跑", async () => {
        const next = await scopedApi("/api/eval/jobs/" + job.id + "/rerun", {});
        await openJob(next.id);
      });
      button(actions, "重跑失败、待确认和未完成用例", async () => {
        const next = await scopedApi("/api/eval/jobs/" + job.id + "/rerun", {
          failed_only: true,
        });
        await openJob(next.id);
      });
    }
    if (job.variants.some((v) => v.runtime !== "claude-sdk"))
      append(box, "p", "此任务含已停用执行层，保留历史与导出；需要运行时请新建 SDK 任务。", "muted");
    button(actions, "导出完整 JSON", async () =>
      download(
        "lifeos-evaluation-" + job.id + ".json",
        await scopedApi("/api/eval/jobs/" + job.id + "/export"),
      ),
    );
    button(actions, "导出汇总 CSV", async () => {
      const data = await scopedApi("/api/eval/jobs/" + job.id + "/export");
      const rows = [
        [
          "用例",
          "方案",
          "执行层",
          "提示词组合",
          "执行状态",
          "系统整体判定",
          "人工整体判定",
          "耗时ms",
          "人工备注",
        ],
        ...data.records.map((r) => [
          r.case.title,
          r.variant,
          r.runtime,
          r.bundle_id,
          r.execution_status,
          verdicts[r.assessments.overall.verdict],
          verdicts[r.latest_reviews.overall?.verdict] || "未复核",
          r.elapsed_ms,
          r.latest_reviews.overall?.note || "",
        ]),
      ];
      const csv = rows
        .map((row) =>
          row
            .map(
              (v) =>
                '"' +
                String(v)
                  .replace(/^[=+@-]/, "'$&")
                  .replaceAll('"', '""') +
                '"',
            )
            .join(","),
        )
        .join("\r\n");
      download("lifeos-summary-" + job.id + ".csv", "\uFEFF" + csv, "text/csv");
    });
    json(box, "本批次固定的版本、输入与提示词文档", job.snapshot);
    const filter = select(
      box,
      "按整体系统判定筛选",
      "ev-result-filter",
      [
        ["all", "全部"],
        ["pass", "通过"],
        ["fail", "失败"],
        ["pending", "待确认"],
      ],
      selectedFilter,
    );
    const list = append(box, "div");
    const show = () => {
      list.replaceChildren();
      for (const c of job.snapshot.cases) {
        const matches = job.results.filter((r) => r.case_id === c.id);
        if (
          filter.value !== "all" &&
          !matches.some((r) => r.status === filter.value)
        )
          continue;
        const row = append(list, "div", undefined, "case-row");
        append(row, "strong", c.title);
        for (const v of job.variants) {
          const r = matches.find((r) => r.variant === v.label);
          append(
            row,
            "p",
            v.label + "：" + (r ? verdicts[r.status] : "尚未完成"),
          );
        }
        if (matches.length)
          button(row, "查看五环节、整体评测与 A/B 对比", () =>
            openCase(matches),
          );
      }
    };
    filter.onchange = show;
    show();
    if (retained) box.append(retained);
    else append(box, "div").id = "ev-result-details";
  }
  async function openCase(matches) {
    const token = version,
      jobid = currentJob;
    const records = await Promise.all(
      matches.map((r) => scopedApi("/api/eval/results/" + r.id)),
    );
    if (token !== version || jobid !== currentJob) return;
    const box = q("ev-result-details");
    box.replaceChildren();
    append(box, "h2", records[0].case.title);
    const columns = append(box, "div", undefined, "results");
    for (const record of records) renderResult(columns, record);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderResult(parent, record) {
    const box = append(parent, "article");
    append(
      box,
      "h2",
      "方案 " + record.variant + " · " + labels[record.runtime],
    );
    append(
      box,
      "p",
      "执行" +
        (record.execution_status === "success" ? "完成" : "失败") +
        " · " +
        (record.elapsed_ms / 1000).toFixed(2) +
        " 秒 · 判定器" +
        (record.judge_status === "unavailable"
          ? "模型不可用，未判定"
          : record.judge_status === "error"
          ? "失败，需复核"
          : record.judge_status === "not_needed"
            ? "未调用"
            : "已完成"),
    );
    append(box, "small", "提示词组合 " + record.bundle_id);
    for (const s of record.steps) {
      const d = append(box, "details");
      d.open =
        s.step === record.steps.filter((x) => x.kind === "chat").at(-1)?.step;
      append(
        d,
        "summary",
        "步骤 " +
          s.step +
          " · " +
          kinds[s.kind] +
          " · " +
          (s.status === "success" ? "执行完成" : "执行失败"),
      );
      append(d, "pre", s.input.query || JSON.stringify(s.input));
      if (s.execution)
        append(d, "pre", s.execution.result?.markdown || s.execution.message);
      if (s.output)
        append(
          d,
          "pre",
          typeof s.output === "string" ? s.output : s.output.markdown,
        );
      json(d, "工具、观察输出与记忆前后状态", s);
    }
    append(box, "h3", "系统判定与人工复核");
    for (const key of [
      "overall",
      "understanding",
      "retrieval",
      "reply",
      "memory",
      "summary",
    ]) {
      const name = stages[key],
        card = append(box, "details", undefined, "stage-card");
      card.open = key === "overall";
      append(
        card,
        "summary",
        name +
          " · 系统：" +
          verdicts[record.assessments[key].verdict] +
          " · 人工：" +
          (verdicts[record.latest_reviews[key]?.verdict] || "未复核"),
      );
      append(card, "h3", name);
      append(
        card,
        "p",
        "标准：" +
          (record.case.criteria[key] || "未填写文字标准，可查看自动规则。"),
        "compact-summary",
      );
      const assessment = record.assessments[key];
      append(
        card,
        "span",
        "系统：" + verdicts[assessment.verdict],
        "badge verdict-" + assessment.verdict,
      );
      append(card, "p", assessment.reason);
      json(card, "自动规则与证据索引", assessment);
      for (const ref of assessment.evidence || []) {
        const parts = ref.split(":");
        const s = record.steps.find((s) => s.step === Number(parts[1]));
        const evidence =
          parts[2] === "input"
            ? s?.input
            : parts[2] === "memory_before"
              ? s?.memories_before
              : parts[2] === "memory_after"
                ? s?.memories_after
                : parts[2] === "answer"
                  ? s?.execution?.result?.result
                  : parts[2] === "output"
                    ? s?.output
                    : s?.observations?.[parts[2]];
        json(card, "依据 " + ref, evidence);
      }
      const latest = record.latest_reviews[key];
      append(
        card,
        "p",
        latest
          ? "人工：" +
              verdicts[latest.verdict] +
              " · " +
              latest.author +
              " · " +
              latest.note
          : "人工：未复核",
        "muted",
      );
      const vid = "ev-review-" + record.id + "-" + key;
      select(
        card,
        "人工结论",
        vid,
        Object.entries(verdicts),
        latest?.verdict || "pending",
      );
      field(
        card,
        "复核依据 / 备注",
        vid + "-note",
        latest?.note || "",
        "textarea",
      ).maxLength = 2000;
      button(card, "保存 " + name + " 复核", async () => {
        await scopedApi("/api/eval/results/" + record.id + "/review", {
          stage: key,
          verdict: q(vid).value,
          note: q(vid + "-note").value,
        });
        const ids = [...q("ev-result-details").querySelectorAll("article")]
          .map((a) => a.dataset.record)
          .filter(Boolean);
        await openCase(ids.map((id) => ({ id })));
        await openJob(currentJob);
        note("人工结论已记录，系统原判定保留。");
      });
    }
    box.dataset.record = record.id;
    json(box, "人工复核历史", record.reviews);
    button(box, "下载本用例结果", () =>
      download("lifeos-case-" + record.id + ".json", record),
    );
  }
  async function showPrompts() {
    const panel = q("ev-prompt");
    panel.replaceChildren();
    const grid = append(panel, "div", undefined, "bench-grid");
    const menu = append(grid, "section");
    append(menu, "h2", "提示词模块");
    for (const [key, name] of Object.entries(catalog.modules))
      button(
        menu,
        name,
        async () => {
          module = key;
          await showPrompts();
        },
        "library-item" + (module === key ? " active" : ""),
      );
    const content = append(grid, "section");
    append(content, "h2", catalog.modules[module]);
    append(
      content,
      "p",
      "编辑后保存为新版本；组合用于测试，单独启用后才影响产品。前三个模块合成主 Agent 提示词，记忆与摘要共用整理调用，评测展示仍分开。",
      "muted",
    );
    const versions = catalog.versions.filter((v) => v.module === module);
    const current = catalog.bundles.find(
      (b) => b.id === catalog.active_bundle_id,
    ).versions[module];
    const selector = select(
      content,
      "读取 / 编辑版本",
      "ev-prompt-version",
      versions.map((v) => [
        v.id,
        v.note + " · " + v.hash.slice(0, 8) + " · " + v.author,
      ]),
      current,
    );
    selector.onchange = () => guard(() => loadPromptVersion(selector.value));
    field(
      content,
      "提示词正文（独立 Markdown 文档）",
      "ev-prompt-content",
      "",
      "textarea",
    ).className = "code prompt-code";
    field(content, "本次版本说明", "ev-prompt-note", "").maxLength = 500;
    const controls = append(content, "div", undefined, "row");
    button(
      controls,
      "保存新版本",
      async () => {
        const saved = await scopedApi("/api/prompts/versions", {
          module,
          content: q("ev-prompt-content").value,
          parent: loadedVersion?.id || "",
          note: q("ev-prompt-note").value,
        });
        catalog = await scopedApi("/api/prompts");
        await showPrompts();
        q("ev-prompt-version").value = saved.id;
        await loadPromptVersion(saved.id);
        note(
          "新版本已保存；产品继续使用原启用组合。将新版本加入组合后可评测。",
        );
      },
      "primary",
    );
    button(controls, "导出当前正文 .md", () =>
      download(module + ".md", q("ev-prompt-content").value, "text/markdown"),
    );
    const input = field(
      content,
      "从 .md 文档加载到编辑器",
      "ev-prompt-file",
      "",
      "input",
    );
    input.type = "file";
    input.accept = ".md,.txt";
    input.onchange = () =>
      guard(async () => {
        const f = input.files[0];
        if (f) {
          if (f.size > 96000) throw Error("文档过大。");
          q("ev-prompt-content").value = await f.text();
          note("文档已加载；保存版本后才进入版本库。");
        }
      });
    const compare = select(
      content,
      "对比另一个版本",
      "ev-diff-version",
      versions.map((v) => [v.id, v.note + " · " + v.hash.slice(0, 8)]),
      versions[0].id,
    );
    button(content, "查看版本差异", async () => {
      const diff = await scopedApi("/api/prompts/diff", {
        left: q("ev-prompt-version").value,
        right: compare.value,
      });
      q("ev-diff-output").textContent = diff.diff || "两个版本内容相同。";
    });
    append(content, "pre", "选择两个已保存版本，查看正文变化。").id =
      "ev-diff-output";
    await loadPromptVersion(current);
    await showBundles(panel);
  }
  async function loadPromptVersion(id) {
    loadedVersion = await scopedApi("/api/prompts/versions/" + id);
    q("ev-prompt-content").value = loadedVersion.content;
    q("ev-prompt-note").value = "";
  }
  async function showBundles(panel) {
    const box = append(panel, "section");
    append(box, "h2", "组合、测试与产品启用");
    select(
      box,
      "读取已有组合 / 回滚到旧组合",
      "ev-base-bundle",
      choices(),
      catalog.active_bundle_id,
    ).onchange = () => loadBundle(q("ev-base-bundle").value);
    const selects = append(box, "div", undefined, "stage-grid");
    for (const [key, name] of Object.entries(catalog.modules))
      select(
        selects,
        name,
        "ev-bundle-module-" + key,
        catalog.versions
          .filter((v) => v.module === key)
          .map((v) => [v.id, v.note + " · " + v.hash.slice(0, 8)]),
      );
    field(box, "新组合名称", "ev-bundle-name", "").maxLength = 120;
    const actions = append(box, "div", undefined, "row");
    button(
      actions,
      "保存为新组合",
      async () => {
        const versions = Object.fromEntries(
          Object.keys(catalog.modules).map((m) => [
            m,
            q("ev-bundle-module-" + m).value,
          ]),
        );
        const b = await scopedApi("/api/prompts/bundles", {
          name: q("ev-bundle-name").value,
          versions,
        });
        catalog = await scopedApi("/api/prompts");
        await showPrompts();
        q("ev-base-bundle").value = b.id;
        loadBundle(b.id);
        populateFree();
        note("组合已保存，产品尚未切换。可到批量运行页选择它评测。");
      },
      "primary",
    );
    button(actions, "导出组合 JSON（可再导入）", async () =>
      download(
        "lifeos-prompts-" + q("ev-base-bundle").value + ".json",
        await scopedApi("/api/prompts/bundles/" + q("ev-base-bundle").value),
      ),
    );
    button(actions, "导出组合文档 .md", async () => {
      const bundle = await scopedApi(
        "/api/prompts/bundles/" + q("ev-base-bundle").value,
      );
      const text =
        "# " +
        bundle.name +
        "\n\n组合 ID：" +
        bundle.id +
        "\n\n" +
        Object.entries(bundle.documents)
          .map(
            ([key, doc]) =>
              "## " +
              key +
              " · " +
              catalog.modules[key] +
              "\n\n版本：" +
              doc.id +
              "\n\n" +
              doc.content,
          )
          .join("\n\n") +
        "\n\n" +
        Object.entries(bundle.contracts || {})
          .map(([name, content]) => "## 输出契约 · " + name + "\n\n" + content)
          .join("\n\n");
      download("lifeos-prompts-" + bundle.id + ".md", text, "text/markdown");
    });
    const file = field(
      box,
      "导入组合 JSON（保存为新版本和新组合，不启用）",
      "ev-import-prompts",
      "",
      "input",
    );
    file.type = "file";
    file.accept = ".json";
    file.onchange = () =>
      guard(async () => {
        const f = file.files[0];
        if (f) {
          if (f.size > 1000000) throw Error("文件最大 1 MB。");
          const saved = await scopedApi(
            "/api/prompts/import",
            JSON.parse(await f.text()),
          );
          catalog = await scopedApi("/api/prompts");
          await showPrompts();
          q("ev-base-bundle").value = saved.id;
          loadBundle(saved.id);
          populateFree();
          note("组合已导入，需完成评测后单独启用。");
        }
      });
    append(
      box,
      "p",
      "产品当前：" +
        catalog.bundles.find((b) => b.id === catalog.active_bundle_id).name +
        " · " +
        catalog.active_bundle_id,
      "stat-line",
    );
    append(
      box,
      "p",
      "启用会影响此部署的所有产品用户。新组合须先完成至少一个评测用例；执行过不代表质量合格，请先复核结果。旧启用组合可以回滚。",
      "warning-note",
    );
    field(box, "启用 / 回滚原因", "ev-activation-note", "").maxLength = 500;
    button(box, "将选中的已有组合启用到产品", async () => {
      const bid = q("ev-base-bundle").value;
      await scopedApi("/api/prompts/activate", {
        bundle_id: bid,
        expected_active: catalog.active_bundle_id,
        note: q("ev-activation-note").value,
      });
      catalog = await scopedApi("/api/prompts");
      await showPrompts();
      populateFree();
      note("产品提示词已切换；正在运行的测试仍使用提交时的快照。");
    });
    const history = append(box, "details");
    append(history, "summary", "产品启用与回滚记录");
    for (const a of catalog.activations) {
      const row = append(history, "div", undefined, "history-item");
      append(
        row,
        "p",
        new Date(a.created * 1000).toLocaleString() +
          " · " +
          a.author +
          " · " +
          a.note,
      );
      append(row, "small", a.bundle_id);
      button(row, "选择此历史组合", () => {
        q("ev-base-bundle").value = a.bundle_id;
        loadBundle(a.bundle_id);
        q("ev-activation-note").value = "回滚：" + a.note;
        note("已选择历史组合，填写原因并点击启用后生效。");
      });
    }
    loadBundle(catalog.active_bundle_id);
  }
  function loadBundle(id) {
    const bundle = catalog.bundles.find((b) => b.id === id);
    if (!bundle) return;
    for (const [key, value] of Object.entries(bundle.versions))
      q("ev-bundle-module-" + key).value = value;
    q("ev-bundle-name").value = bundle.name + "（新版本）";
  }
  return { enter, stop };
})();
document.addEventListener("lifeos-login", (event) =>
  Evals.enter(event.detail).catch(
    (error) =>
      (document.getElementById("ev-status").textContent = error.message),
  ),
);
document.addEventListener("lifeos-logout", () => Evals.stop());
