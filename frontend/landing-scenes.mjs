// Replace a clip, its poster or its prompt here; no layout changes are needed.
export const LANDING_SCENES=[
 {id:'commute',name:'通勤与生活',line:'把路上的时间，留一点给自己。',label:'通勤',video:'assets/scenes/commute.mp4',poster:'assets/scenes/commute.jpg',position:'50% 50%',prompt:'我想聊聊通勤和生活安排，怎么权衡住处、通勤时间和日常精力？'},
 {id:'home',name:'搬家这件事',line:'下一处住处，也是一种生活选择。',label:'住处',video:'assets/scenes/home.mp4',poster:'assets/scenes/home.jpg',position:'50% 50%',prompt:'准备租房搬家，选房和签约前有哪些事需要先确认？'},
 {id:'focus',name:'把专注找回来',line:'给眼前的事，留一段不被打断的时间。',label:'专注',video:'assets/scenes/focus.mp4',poster:'assets/scenes/focus.jpg',position:'50% 50%',prompt:'我想减少手机通知对工作的打断，找回专注，可以从哪里开始？'},
 {id:'night',name:'今晚，早点休息',line:'生活里的很多事，可以从睡个好觉开始。',label:'睡眠',video:'assets/scenes/night.mp4',poster:'assets/scenes/night.jpg',position:'50% 50%',prompt:'我想调整作息、改善睡眠，可以先从哪些事情开始？'}
];
export function sceneAt(index){return LANDING_SCENES[((index%LANDING_SCENES.length)+LANDING_SCENES.length)%LANDING_SCENES.length];}
