// Presentation fixtures only: opening a project never submits a prompt or saves memory.
export const demoProject={id:'moving-demo',title:'搬家计划'};
const samples=[
  {id:'needs',title:'先理清搬家的需求',turns:[
    ['最近想搬家，但一想到要筛房源、看房、打包，就觉得很乱。','我们先把“搬家”**拆成几段**，不急着同时处理。\n\n## 每段对话，推进一件事\n\n1. 你想住在哪里。\n2. 怎样安排看房。\n3. 搬走前要准备什么。\n\n之后回来也能接得上。先从最影响日常生活的部分开始：**这次搬家，你最希望改善什么？**'],
    ['主要是通勤。现在每天来回快两个小时，希望能控制在一小时以内。','那先把**“通勤往返一小时内”**设成这次筛选的首要条件。\n\n## 先缩小范围\n\n1. 列两三个候选片区。\n2. 用工作日实际出发时间估算路线。\n3. 周末看房时，顺路走一遍从车站到小区的路。\n\n### 接下来补齐两项信息\n\n- 大致预算。\n- 希望什么时候搬。\n\n其他细节可以留到下一段对话。']
  ]},
  {id:'visits',title:'周末看房怎么安排',turns:[
    ['假设周六有三套房可以看，我想安排得紧凑一点，又不想看完就全忘了。','可以把这次看房当作**同一趟行程**来准备。\n\n## 出发前\n\n1. 把三个地址按路线排好，确认时间和联系人。\n2. 每套之间留出路上和记录的时间。\n\n## 现场\n\n- 用同一份清单记录采光、噪音、通勤路线和你最在意的问题。\n- 拍照前先征得同意，离开后马上写一句直观感受。\n\n## 看完后\n\n回到这段对话，逐套补充记录。我们再按**同一组条件**对比，避免只记得最后看的一套。']
  ]},
  {id:'packing',title:'搬家前要准备什么',turns:[
    ['如果房子确定了，搬家前一周应该怎么安排？我不想最后一天才开始收拾。','可以先排一份**能调整的准备顺序**。\n\n## 提前一周\n\n1. 确认搬家时间、交通安排和新旧住处的交接事项。\n2. 整理不再需要的东西，**先打包低频物品**。\n\n## 提前两三天\n\n- 按房间分装，箱子上写清内容和放置位置。\n- **单独留一包随身必需品**：证件、充电器、洗漱用品和换洗衣物。\n\n## 搬家当天\n\n1. 先核对重要物品，再按清单检查遗漏。\n2. 到新住处后先整理床铺和洗漱区，让当晚可以正常休息。\n\n> 这份顺序只是项目演示。实际安排可以继续在这段对话里细化。']
  ]}
];
export function createProjectExamples(){return samples.map(sample=>({id:`project-demo-${sample.id}`,title:sample.title,projectId:demoProject.id,projectTitle:demoProject.title,fixture:true,created:0,draft:'',followupId:'',serverId:'',turns:sample.turns.map(([query,message],i)=>({id:`sample-${sample.id}-${i}`,query,status:'completed',response:{example:true,result:{message,cards:[]},summary:{saved:false,message:''}}}))}));}
