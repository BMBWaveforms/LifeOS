/* Fixed conversation starters. Guide text is read from the authenticated API. */
window.LifeScenes = Object.freeze([
  {id:'scene-renting',title:'租房押金，怎样留个底',guide_id:'15-01',guide_title:'租房时押金的数额、退还时间和扣减情形，必须写进合同',draft:'我最近在租房，想了解押金和合同需要注意什么。',image:'assets/scene-moving.webp',alt:'阳光下的搬家纸箱与新住处'},
  {id:'scene-commute',title:'把通勤的时间还给自己',guide_id:'04-18',guide_title:'选住处时把通勤时长放在前面，缩短单程通勤',draft:'我正在考虑住处，想聊聊通勤时间和租金该怎么取舍。',image:'assets/scene-commute.webp',alt:'晨光里坐在列车窗边的乘客'},
  {id:'scene-focus',title:'给专注留一点空间',guide_id:'03-01',guide_title:'关掉非必要通知，工作时把手机放到视线之外',draft:'我工作时经常被手机和通知打断，想了解有什么可以尝试的办法。',image:'assets/scene-focus.webp',alt:'窗边的笔记本、电脑和工作桌'},
  {id:'scene-walking',title:'从每天多走一点开始',guide_id:'02-11',guide_title:'每天走到 7000–8000 步，或者每周累计快走 150–300 分钟',draft:'我想把走路变成日常习惯，应该从哪里开始？',image:'assets/scene-walking.webp',alt:'金色晨光下的街巷漫步'},
  {id:'scene-subscriptions',title:'看看那些悄悄续费的订阅',guide_id:'05-01',guide_title:'关掉所有自动续费，改为到期手动续',draft:'我想整理自动续费的订阅，避免忘记取消，有什么指南建议？',image:'assets/scene-moving.webp',alt:'阳光下安静有序的生活空间'},
  {id:'scene-travel',title:'出发前，备好重要证件',guide_id:'21-07',guide_title:'护照、签证、身份证都拍照存一份在云端，丢了先报警再补旅行证',draft:'我准备出门旅行，想了解证件备份和丢失后的处理。',image:'assets/scene-commute.webp',alt:'列车窗外的旅途风景'},
  {id:'scene-contract',title:'签租房合同前，再核对一遍',guide_id:'15-06',guide_title:'租房签约前核对产权证和抵押情况，所有款项走转账并备注用途',draft:'我准备签租房合同，应该核对哪些证件和付款信息？',image:'assets/scene-focus.webp',alt:'桌面上准备核对的资料'},
  {id:'scene-tasks',title:'事情太大，就先拆小一点',guide_id:'04-07',guide_title:'把大任务拆成子任务再估时、再开工',draft:'我手头的任务很大，总是不知道从哪里开始，怎么拆分比较好？',image:'assets/scene-walking.webp',alt:'晨光里一步一步向前的街道'}
].map(scene=>Object.freeze(scene)));
