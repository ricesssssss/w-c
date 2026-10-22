
// ========================================
// DATA LAYER
// ========================================
const STORAGE_KEY = 'wc_workbench_v3';

const DEFAULT_DATA = {
  settings: {
    apiKey: '',
    apiEndpoint: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    visionEndpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    visionKey: '',
    visionModel: 'qwen-vl-max-latest',
    wDisplay: 'W',
    cDisplay: 'C',
    targetWeight: {W:58, C:72},
    wHeight: 160, cHeight: 175,
    wGender: '女', cGender: '男',
    wAge: 25, cAge: 25,
    wActivity: '轻度', cActivity: '轻度',
    planStart: '',
    engStart: '',
    fitAIWithData: true,
    upstashUrl: '',
    upstashToken: ''
  },
  sidebars: ['W&C 健身减脂', '英语学习'],
  fitness: [],        // {id,date,time,person,type,content,calories,protein,fat,carbs,fiber,source,confirmed}
  weightLog: [],      // {id,date,person,weight,source,time}
  pendingFitness: [], // {id,person,type,content,calories,protein,fat,carbs,fiber,basis,source,createdAt} AI 待确认
  planTasks: [],      // {id,date,person,content,done}
  fitSummary: {},     // {date:'YYYY-MM-DD', text:'...'} 晚间总结缓存
  fitRemindLog: {},   // {date:'YYYY-MM-DD':true} 提醒已展示记录
  engTasks: [],       // {id,date,type,content,answer,review,done} type: grammar/practice/vocab/speaking/article
  ankiCards: [],      // {id,front,back,sub,source,createdAt,due,interval,ease,reps,lapses}
  aiChatEng: [],      // {role,content,time}
  aiChatFit: []       // {role,content,time}

};

// 运动 MET 值表（程序按 MET×体重×时长 估算消耗，AI 负责理解项目强度）
const MET_TABLE = {
  '快走':3.5,'慢跑':7,'跑步':9.8,'游泳':6,'骑行':6,'跳绳':11,'力量训练':5,'瑜伽':2.5,
  '爬楼梯':8,'椭圆机':5,'健身操':5,'羽毛球':7,'篮球':6.5,'网球':7.3,'跳舞':5,'HIIT':8,'散步':2.5,'爬山':6
};
function estExercise(person, exercise, minutes){
  const met = MET_TABLE[exercise] || 5;
  const wls = [...DATA.weightLog].reverse().find(w=>w.person===person);
  const kg = wls? wls.weight : (person==='W'?60:70);
  const h = minutes/60;
  const base = met*kg*h;
  return {min:Math.round(base*0.85), max:Math.round(base*1.15), met, kg};
}

// ---- 代谢 & 营养素计算 ----
function getLatestWeight(person){
  const wls=[...DATA.weightLog].reverse().find(w=>w.person===person);
  return wls?wls.weight:(person==='W'?60:70);
}
function calcBMR(person){
  const kg=getLatestWeight(person);
  const h=(person==='W'?getS('wHeight',160):getS('cHeight',175));
  const age=(person==='W'?getS('wAge',25):getS('cAge',25));
  const gender=(person==='W'?getS('wGender','女'):getS('cGender','男'));
  // Mifflin-St Jeor
  if(gender==='男') return Math.round(10*kg + 6.25*h - 5*age + 5);
  return Math.round(10*kg + 6.25*h - 5*age - 161);
}
function calcTDEE(person){
  const bmr=calcBMR(person);
  const act=(person==='W'?getS('wActivity','轻度'):getS('cActivity','轻度'));
  const factors={久坐:1.2,轻度:1.375,中度:1.55,重度:1.725};
  return Math.round(bmr*(factors[act]||1.375));
}
function calcBMI(person){
  const kg=getLatestWeight(person);
  const h=(person==='W'?getS('wHeight',160):getS('cHeight',175))/100;
  return (kg/(h*h)).toFixed(1);
}
function recordWeight(person, val){
  const v=parseFloat(val);
  if(!v || v<=0 || v>300) return toast('请输入有效体重（1-300 kg）');
  DATA.weightLog.push({id:uid(),date:today(),person,weight:Math.round(v*10)/10,source:'手动',time:now()});
  saveData(); renderFitnessContent(); toast('体重已记录');
}
function dailyMacroTargets(person){
  const tdee=calcTDEE(person);
  // 减脂期：蛋白质 2g/kg LBM 估算，碳水 40%，脂肪 30%
  const kg=getLatestWeight(person);
  return {
    calories:tdee-400, // 推荐减脂摄入（日缺400kcal≈月减1.6kg）
    protein:Math.round(kg*2),
    fat:Math.round((tdee-400)*0.3/9),
    carbs:Math.round((tdee-400)*0.4/4),
    fiber:25
  };
}
function calcTodayMacros(person){
  const td=today();
  const recs=DATA.fitness.filter(r=>r.date===td&&r.person===person);
  const calIn=recs.filter(r=>r.type==='摄入').reduce((s,r)=>s+(r.calories||0),0);
  const calOut=recs.filter(r=>r.type==='消耗').reduce((s,r)=>s+(r.calories||0),0);
  const protein=recs.filter(r=>r.type==='摄入').reduce((s,r)=>s+(r.protein||0),0);
  const fat=recs.filter(r=>r.type==='摄入').reduce((s,r)=>s+(r.fat||0),0);
  const carbs=recs.filter(r=>r.type==='摄入').reduce((s,r)=>s+(r.carbs||0),0);
  const fiber=recs.filter(r=>r.type==='摄入').reduce((s,r)=>s+(r.fiber||0),0);
  return {calIn,calOut,protein,fat,carbs,fiber};
}

let DATA = {};
let activeModule = '';
let activeTab = '';
let activePerson = localStorage.getItem('wc_activePerson') || 'W'; // 角色模式：W or C
let tlDate = '';
let tlFilter = 'all';
let dataViewMode = 'chart';
let dataTrendRange = 30;
let ankiQueue = [];
let ankiIdx = 0;
let ankiFlipped = false;
let planView = 'plan';

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    DATA = raw ? deepMerge(JSON.parse(JSON.stringify(DEFAULT_DATA)), JSON.parse(raw)) : JSON.parse(JSON.stringify(DEFAULT_DATA));
  } catch(e) { DATA = JSON.parse(JSON.stringify(DEFAULT_DATA)); }
  // migrate v2
  try {
    const old = localStorage.getItem('wc_workbench_v2');
    if (old && !localStorage.getItem('wc_migrated_v3')) {
      const o = JSON.parse(old);
      if (o.fitness) DATA.fitness = o.fitness;
      if (o.weightLog) DATA.weightLog = o.weightLog;
      if (o.planTasks) DATA.planTasks = o.planTasks;
      if (o.wordBank) DATA.wordBank = o.wordBank;
      if (o.aiChat) DATA.aiChatEng = o.aiChat;
      if (o.settings) Object.assign(DATA.settings, o.settings);
      localStorage.setItem('wc_migrated_v3','1');
      saveData();
    }
  } catch(e){}
  // 迁移：fhl.mom 在中国境内被屏蔽；文本切 DeepSeek，视觉独立配通义
  try {
    if ((DATA.settings.apiEndpoint||'').indexOf('fhl.mom') >= 0) {
      DATA.settings.apiEndpoint = 'https://api.deepseek.com';
      DATA.settings.model = 'deepseek-chat';
      DATA.settings.visionEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
      DATA.settings.visionModel = 'qwen-vl-max-latest';
    }
    // 上一轮误将文本模型也设为 qwen，纠正回 DeepSeek
    if (DATA.settings.model === 'qwen-vl-max-latest') DATA.settings.model = 'deepseek-chat';
    if (!DATA.settings.visionEndpoint) DATA.settings.visionEndpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    if (!DATA.settings.visionModel) DATA.settings.visionModel = 'qwen3.7-plus';
    // 老下拉里用了控制台名（首字母大写），改为 API 名（首字母小写）
    if (/^[A-Z]/.test(DATA.settings.visionModel||'')) DATA.settings.visionModel = 'qwen3.7-plus';
    saveData();
  } catch(e){}
}
function deepMerge(def, saved) {
  const r = def;
  for (const k in saved) {
    if (saved[k] && typeof saved[k] === 'object' && !Array.isArray(saved[k]) && def[k] && typeof def[k] === 'object' && !Array.isArray(def[k])) {
      r[k] = deepMerge(Object.assign({}, def[k]), saved[k]);
    } else {
      r[k] = saved[k];
    }
  }
  return r;
}
// ---- Upstash Redis 实时云同步（免费，新加坡节点国内可用） ----
async function cloudSave(){
  const url=getS('upstashUrl',''), token=getS('upstashToken','');
  if(!url||!token) return;
  try{
    await fetch(url+'/set/wc_data',{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify(DATA)});
  }catch(e){}
}
async function cloudLoad(callback){
  const url=getS('upstashUrl',''), token=getS('upstashToken','');
  if(!url||!token){ if(callback) callback(null); return; }
  try{
    const resp=await fetch(url+'/get/wc_data',{headers:{Authorization:'Bearer '+token}});
    const j=await resp.json();
    if(callback) callback(j.result?JSON.parse(j.result):null);
  }catch(e){ if(callback) callback(null); }
}
function syncNow(){
  const url=getS('upstashUrl','');
  if(!url) return toast('请先在设置中配置 Upstash');
  toast('同步中…');
  cloudLoad(remote=>{
    if(!remote) return toast('云端暂无数据，请先用一台手机上传');
    DATA=deepMerge(JSON.parse(JSON.stringify(DATA)),remote);
    saveData(); renderFitnessContent(); loadModule(activeModule);
    toast('已同步云端数据');
  });
}
function pushToCloud(){
  const url=getS('upstashUrl','');
  if(!url) return toast('请先在设置中配置 Upstash');
  cloudSave().then(()=>toast('已上传到云端'));
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(DATA));
  cloudSave(); // 自动上传云端
}
function getS(k,d) { return DATA.settings[k] !== undefined ? DATA.settings[k] : d; }
function setS(k,v) { DATA.settings[k]=v; saveData(); }
function uid() { return Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
function today() { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function now() { return new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}); }
function addDays(dateStr,n){ const d=new Date(dateStr+'T00:00:00'); d.setDate(d.getDate()+n); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function getDayIndex(dateStr){ const s=getS('engStart','')||dateStr; const a=new Date(s+'T00:00:00'),b=new Date(dateStr+'T00:00:00'); return Math.max(0,Math.round((b-a)/86400000)); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// 轻量 Markdown 渲染（AI 回复用）：粗体/斜体/行内代码/列表/空行
function md(s){
  if(!s) return '';
  const lines=String(s).split('\n');
  let out=[],listOpen=false;
  const closeList=()=>{ if(listOpen){out.push('</div>');listOpen=false;} };
  for(const raw of lines){
    let line=esc(raw);
    line=line.replace(/`([^`]+)`/g,'<code class="md-code">$1</code>')
             .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
             .replace(/\*([^*]+)\*/g,'<em>$1</em>');
    if(/^\s*[-*]\s+/.test(raw)){
      if(!listOpen){out.push('<div class="md-list">');listOpen=true;}
      out.push('<div class="md-li">• '+line.replace(/^\s*[-*]\s+/,'')+'</div>');
    }else if(/^\s*\d+\.\s+/.test(raw)){
      if(!listOpen){out.push('<div class="md-list">');listOpen=true;}
      out.push('<div class="md-li">'+line+'</div>');
    }else{
      closeList();
      if(raw.trim()===''){ out.push('<div class="md-gap"></div>'); }
      else{ out.push('<div class="md-p">'+line+'</div>'); }
    }
  }
  closeList();
  return out.join('');
}

// ========================================
// ENGLISH CONTENT BANKS
// ========================================
// Vocabulary: 6 themes x 10 words
const VOCAB_THEMES = ['商务邮件','商务谈判','国际贸易','财务金融','职场沟通','产品营销'];
const VOCAB_BANK = [
  // 商务邮件
  {w:'quotation',p:'/kwoʊˈteɪʃən/',m:'n. 报价单',r:'quot(引用)+ation',c:['send a quotation','quotation for bulk order'],e:'Please send us your latest quotation for the bulk order.',t:0},
  {w:'invoice',p:'/ˈɪnvɔɪs/',m:'n. 发票',r:'in+voice(票据)',c:['issue an invoice','commercial invoice'],e:'We will issue the invoice once the goods are dispatched.',t:0},
  {w:'attachment',p:'/əˈtætʃmənt/',m:'n. 附件',r:'attach(附上)+ment',c:['email attachment','please find attached'],e:'Please find the contract in the attachment.',t:0},
  {w:'deadline',p:'/ˈdedlaɪn/',m:'n. 截止日期',r:'dead+line',c:['meet the deadline','tight deadline'],e:'The deadline for submitting the proposal is Friday.',t:0},
  {w:'confirm',p:'/kənˈfɜːrm/',m:'v. 确认',r:'con+firm(确定)',c:['confirm the order','confirm receipt'],e:'Could you please confirm receipt of this email?',t:0},
  {w:'inquiry',p:'/ɪnˈkwaɪəri/',m:'n. 询盘/咨询',r:'inquir(询问)+y',c:['product inquiry','respond to an inquiry'],e:'Thank you for your inquiry about our products.',t:0},
  {w:'cc',p:'/ˌsiː ˈsiː/',m:'v./n. 抄送',r:'carbon copy',c:['cc the manager','keep me cc\'d'],e:'Please cc me on all future correspondence.',t:0},
  {w:'follow-up',p:'/ˈfɒloʊ ʌp/',m:'n./adj. 跟进',r:'follow+up',c:['follow-up email','follow up on the order'],e:'I am writing to follow up on our previous conversation.',t:0},
  {w:'clarify',p:'/ˈklærɪfaɪ/',m:'v. 澄清',r:'clar(清楚)+ify',c:['clarify the details','clarify a point'],e:'Could you clarify the payment terms in your offer?',t:0},
  {w:'regards',p:'/rɪˈɡɑːrdz/',m:'n. 问候(信末)',r:'re+gard',c:['best regards','kind regards'],e:'Best regards, and looking forward to your reply.',t:0},
  // 商务谈判
  {w:'negotiate',p:'/nɪˈɡoʊʃieɪt/',m:'v. 谈判',r:'negoti(商谈)+ate',c:['negotiate the price','negotiate terms'],e:'We are willing to negotiate the price for long-term cooperation.',t:1},
  {w:'concession',p:'/kənˈseʃən/',m:'n. 让步',r:'con+cess(走)+ion',c:['make a concession','mutual concessions'],e:'Both sides made concessions to reach the agreement.',t:1},
  {w:'compromise',p:'/ˈkɒmprəmaɪz/',m:'n./v. 折中/妥协',r:'com+promise',c:['reach a compromise','acceptable compromise'],e:'Let us find a compromise that works for both parties.',t:1},
  {w:'counteroffer',p:'/ˈkaʊntərˌɒfər/',m:'n. 还盘',r:'counter+offer',c:['make a counteroffer','reject a counteroffer'],e:'Their counteroffer is still above our target price.',t:1},
  {w:'terms',p:'/tɜːrmz/',m:'n. 条款',r:'term(条款)',c:['payment terms','terms and conditions'],e:'We need to review the terms before signing.',t:1},
  {w:'bargain',p:'/ˈbɑːrɡən/',m:'v./n. 议价/便宜货',r:'barg(交易)+ain',c:['bargain over price','drive a hard bargain'],e:'They drove a hard bargain during the negotiation.',t:1},
  {w:'proposal',p:'/prəˈpoʊzəl/',m:'n. 提案/建议',r:'propos(提出)+al',c:['submit a proposal','business proposal'],e:'We will submit a detailed proposal by Monday.',t:1},
  {w:'dispute',p:'/dɪˈspjuːt/',m:'n./v. 争议',r:'dis+pute(思考)',c:['resolve a dispute','contract dispute'],e:'Both parties hope to resolve the dispute amicably.',t:1},
  {w:'agenda',p:'/əˈdʒendə/',m:'n. 议程',r:'ag(做)+enda',c:['meeting agenda','set the agenda'],e:'Let us go through the agenda for today\'s meeting.',t:1},
  {w:'leverage',p:'/ˈlevərɪdʒ/',m:'n./v. 杠杆/优势',r:'lever(杠杆)+age',c:['leverage our strengths','negotiating leverage'],e:'We can leverage our market position in the talks.',t:1},
  // 国际贸易
  {w:'shipment',p:'/ˈʃɪpmənt/',m:'n. 装运/货批',r:'ship+ment',c:['arrange shipment','track the shipment'],e:'The shipment will arrive at the port by next Monday.',t:2},
  {w:'tariff',p:'/ˈtærɪf/',m:'n. 关税',r:'tariff(税率表)',c:['import tariff','tariff policy'],e:'The new tariff policy will affect our import costs.',t:2},
  {w:'customs',p:'/ˈkʌstəmz/',m:'n. 海关',r:'custom(惯例)',c:['clear customs','customs declaration'],e:'The goods are held at customs for inspection.',t:2},
  {w:'logistics',p:'/ləˈdʒɪstɪks/',m:'n. 物流',r:'logist(计算)+ics',c:['logistics company','optimize logistics'],e:'We need to optimize our logistics to reduce delivery time.',t:2},
  {w:'FOB',p:'/ˌef oʊ ˈbiː/',m:'abbr. 离岸价',r:'Free On Board',c:['FOB price','FOB Shanghai'],e:'Please quote us your FOB price for 500 units.',t:2},
  {w:'CIF',p:'/ˌsiː aɪ ˈef/',m:'abbr. 到岸价',r:'Cost Insurance Freight',c:['CIF terms','CIF Rotterdam'],e:'We prefer CIF terms for this order.',t:2},
  {w:'container',p:'/kənˈteɪnər/',m:'n. 集装箱',r:'contain+er',c:['40-foot container','container shipping'],e:'The order requires two 40-foot containers.',t:2},
  {w:'bill of lading',p:'/bɪl əv ˈleɪdɪŋ/',m:'n. 提单',r:'lading(装载)',c:['original bill of lading','clean B/L'],e:'Please send us a copy of the bill of lading.',t:2},
  {w:'warehouse',p:'/ˈwerhaʊs/',m:'n. 仓库',r:'ware(货物)+house',c:['rent a warehouse','warehouse capacity'],e:'The goods are stored in our warehouse near the port.',t:2},
  {w:'lead time',p:'/liːd taɪm/',m:'n. 交货周期',r:'lead+time',c:['shorten lead time','production lead time'],e:'The lead time for this product is about 30 days.',t:2},
  // 财务金融
  {w:'revenue',p:'/ˈrevənuː/',m:'n. 收入/营收',r:'re+ven(来)+ue',c:['annual revenue','revenue growth'],e:'The company expects revenue growth in Q3.',t:3},
  {w:'margin',p:'/ˈmɑːrdʒɪn/',m:'n. 利润率',r:'marg(边缘)+in',c:['profit margin','maintain margin'],e:'We aim to maintain a 20% profit margin.',t:3},
  {w:'turnover',p:'/ˈtɜːrnoʊvər/',m:'n. 营业额',r:'turn+over',c:['annual turnover','turnover increased'],e:'Our annual turnover increased by 15% this year.',t:3},
  {w:'budget',p:'/ˈbʌdʒɪt/',m:'n./v. 预算',r:'budg(钱包)+et',c:['marketing budget','within budget'],e:'The project was completed within budget.',t:3},
  {w:'refund',p:'/ˈriːfʌnd/',m:'n./v. 退款',r:'re+fund(资金)',c:['full refund','request a refund'],e:'We will process the refund within 7 working days.',t:3},
  {w:'deposit',p:'/dɪˈpɒzɪt/',m:'n. 定金/押金',r:'de+posit(放置)',c:['30% deposit','pay a deposit'],e:'We require a 30% deposit before production.',t:3},
  {w:'balance',p:'/ˈbæləns/',m:'n. 余额/尾款',r:'bal(平衡)+ance',c:['balance payment','outstanding balance'],e:'Please arrange the balance payment before shipment.',t:3},
  {w:'currency',p:'/ˈkɜːrənsi/',m:'n. 货币',r:'curr(流动)+ency',c:['foreign currency','currency exchange'],e:'Payment can be made in US dollars or other currency.',t:3},
  {w:'installment',p:'/ɪnˈstɔːlmənt/',m:'n. 分期付款',r:'in+stall(放置)+ment',c:['pay in installments','monthly installment'],e:'The client prefers to pay in three installments.',t:3},
  {w:'audit',p:'/ˈɔːdɪt/',m:'n./v. 审计',r:'aud(听)+it',c:['annual audit','internal audit'],e:'The company passed the annual audit successfully.',t:3},
  // 职场沟通
  {w:'briefing',p:'/ˈbriːfɪŋ/',m:'n. 简报',r:'brief(简短)+ing',c:['project briefing','daily briefing'],e:'The manager gave a briefing on the new project.',t:4},
  {w:'delegate',p:'/ˈdelɪɡət/',m:'v./n. 委派/代表',r:'de+leg(派遣)+ate',c:['delegate tasks','delegate authority'],e:'A good leader knows how to delegate tasks.',t:4},
  {w:'minutes',p:'/ˈmɪnɪts/',m:'n. 会议纪要',r:'minut(小)+es',c:['take minutes','meeting minutes'],e:'Please circulate the minutes after the meeting.',t:4},
  {w:'feedback',p:'/ˈfiːdbæk/',m:'n. 反馈',r:'feed+back',c:['customer feedback','give feedback'],e:'We appreciate your feedback on the sample.',t:4},
  {w:'reschedule',p:'/ˌriːˈskedjuːl/',m:'v. 改期',r:'re+schedule',c:['reschedule the meeting','reschedule delivery'],e:'Could we reschedule the meeting to next Tuesday?',t:4},
  {w:'postpone',p:'/poʊˈspoʊn/',m:'v. 推迟',r:'post(后)+pone(放)',c:['postpone the launch','postpone a decision'],e:'We decided to postpone the product launch.',t:4},
  {w:'urgent',p:'/ˈɜːrdʒənt/',m:'adj. 紧急的',r:'urg(催促)+ent',c:['urgent matter','urgent request'],e:'Please reply as soon as possible; this is urgent.',t:4},
  {w:'supervise',p:'/ˈsuːpərvaɪz/',m:'v. 监督/管理',r:'super(上)+vise(看)',c:['supervise a team','supervise production'],e:'She supervises a team of ten sales representatives.',t:4},
  {w:'colleague',p:'/ˈkɒliːɡ/',m:'n. 同事',r:'col+league(同盟)',c:['senior colleague','work with colleagues'],e:'My colleague will handle your case while I am away.',t:4},
  {w:'handover',p:'/ˈhændoʊvər/',m:'n. 交接',r:'hand+over',c:['project handover','smooth handover'],e:'We arranged a two-week handover period.',t:4},
  // 产品营销
  {w:'branding',p:'/ˈbrændɪŋ/',m:'n. 品牌建设',r:'brand+ing',c:['branding strategy','strong branding'],e:'Good branding helps us stand out in the market.',t:5},
  {w:'campaign',p:'/kæmˈpeɪn/',m:'n. 营销活动',r:'camp(原野)+aign',c:['marketing campaign','launch a campaign'],e:'The new campaign boosted our online sales.',t:5},
  {w:'launch',p:'/lɔːntʃ/',m:'v./n. 发布',r:'launch(投掷)',c:['product launch','launch date'],e:'We plan to launch the new model in September.',t:5},
  {w:'audience',p:'/ˈɔːdiəns/',m:'n. 受众',r:'aud(听)+ience',c:['target audience','reach a wider audience'],e:'Our target audience is young professionals.',t:5},
  {w:'feature',p:'/ˈfiːtʃər/',m:'n. 特点/功能',r:'feat(做)+ure',c:['key feature','unique feature'],e:'The key feature of this model is its durability.',t:5},
  {w:'sample',p:'/ˈsæmpəl/',m:'n. 样品',r:'s(外)+ample(拿)',c:['free sample','sample order'],e:'We can send you a free sample for evaluation.',t:5},
  {w:'catalog',p:'/ˈkætəlɔːɡ/',m:'n. 产品目录',r:'cata(完全)+log(说)',c:['product catalog','latest catalog'],e:'Enclosed is our latest product catalog.',t:5},
  {w:'competitor',p:'/kəmˈpetɪtər/',m:'n. 竞争对手',r:'com+pet(追求)+itor',c:['main competitor','beat competitors'],e:'Our price is lower than that of our competitors.',t:5},
  {w:'warranty',p:'/ˈwɔːrənti/',m:'n. 保修',r:'warrant(保证)+y',c:['two-year warranty','under warranty'],e:'This product comes with a two-year warranty.',t:5},
  {w:'inventory',p:'/ˈɪnvəntɔːri/',m:'n. 库存',r:'in+vent(来)+ory',c:['clear inventory','inventory level'],e:'We need to clear the old inventory before the new season.',t:5}
];

// Grammar bank: 36 points, 3 levels x 12
// {t:title, lv:1-3, r:rule, ex:[2 examples], err:common error, gold:golden sentence,
//  fill:[{q,a}x3], ec:[{q,a}x2], tr:[{q,a}x2]}
const GRAMMAR_BANK = [
// ---- Level 1 ----
{t:'一般现在时',lv:1,r:'表示习惯性动作、客观事实或长期状态。主语为第三人称单数(he/she/it/单数名词)时，动词加 -s/-es。',ex:['She works in a trading company. 她在一家贸易公司工作。','Our factory produces 10,000 units per month. 我们工厂每月生产一万件。'],err:'He work here. → He works here.',gold:'We look forward to your reply. 我们期待您的回复。',
 fill:[{q:'She ___ (work) in the sales department.',a:'works'},{q:'Our company ___ (export) textiles to Europe.',a:'exports'},{q:'The price ___ (include) shipping costs.',a:'includes'}],
 ec:[{q:'He work in a trading company.',a:'He works in a trading company.'},{q:'Our factory produce 10,000 units per month.',a:'Our factory produces 10,000 units per month.'}],
 tr:[{q:'我们期待您的回复。',a:'We look forward to your reply.'},{q:'我们公司向欧洲出口纺织品。',a:'Our company exports textiles to Europe.'}]},
{t:'现在进行时',lv:1,r:'be (am/is/are) + 动词-ing。表示此刻正在进行或近期计划的动作。商务中常用于说明当前进展。',ex:['We are preparing the samples for you. 我们正在为您准备样品。','They are negotiating the contract terms. 他们正在商谈合同条款。'],err:'I am agree with you. → I agree with you. (agree 不用进行时)',gold:'We are working on your order right now. 我们正在处理您的订单。',
 fill:[{q:'We ___ (prepare) the quotation for you now.',a:'are preparing'},{q:'The team ___ (discuss) the new project at the moment.',a:'is discussing'},{q:'I ___ (write) to confirm our meeting tomorrow.',a:'am writing'}],
 ec:[{q:'We are prepare the samples now.',a:'We are preparing the samples now.'},{q:'I am agree with your proposal.',a:'I agree with your proposal.'}],
 tr:[{q:'我们正在为您准备样品。',a:'We are preparing the samples for you.'},{q:'他们正在商谈合同条款。',a:'They are negotiating the contract terms.'}]},
{t:'一般过去时',lv:1,r:'表示过去发生并结束的动作。规则动词加 -ed，注意常见不规则变化(send→sent, make→made, pay→paid)。',ex:['We sent the samples last Friday. 我们上周五寄出了样品。','The client paid the deposit yesterday. 客户昨天付了定金。'],err:'We send the goods last week. → We sent the goods last week.',gold:'We received your payment this morning. 我们今天上午收到了您的付款。',
 fill:[{q:'We ___ (send) the invoice yesterday.',a:'sent'},{q:'The customer ___ (place) an order last week.',a:'placed'},{q:'They ___ (pay) the deposit two days ago.',a:'paid'}],
 ec:[{q:'We send the samples last Friday.',a:'We sent the samples last Friday.'},{q:'The client pay the deposit yesterday.',a:'The client paid the deposit yesterday.'}],
 tr:[{q:'我们上周五寄出了样品。',a:'We sent the samples last Friday.'},{q:'客户昨天付了定金。',a:'The client paid the deposit yesterday.'}]},
{t:'可数与不可数名词',lv:1,r:'可数名词有复数并可数(product, order)；不可数名词无复数(information, advice, feedback, equipment)，谓语用单数。',ex:['Thank you for the information. 感谢您提供的信息。','We received many inquiries this week. 本周我们收到很多询盘。'],err:'Please give me some advices. → Please give me some advice.',gold:'Your feedback is very valuable to us. 您的反馈对我们非常宝贵。',
 fill:[{q:'Thank you for the ___ (information).',a:'information'},{q:'We received many ___ (inquiry) this week.',a:'inquiries'},{q:'Your advice ___ (be) very helpful.',a:'is'}],
 ec:[{q:'Please give me some advices.',a:'Please give me some advice.'},{q:'These informations are useful.',a:'This information is useful.'}],
 tr:[{q:'感谢您提供的信息。',a:'Thank you for the information.'},{q:'您的反馈对我们非常宝贵。',a:'Your feedback is very valuable to us.'}]},
{t:'冠词 a / an / the',lv:1,r:'a/an 首次提及或泛指；the 特指双方都知道的事物。元音音素前用 an(an order, an invoice)。',ex:['Please send us a quotation. 请给我们发一份报价单。','The quotation you sent is competitive. 您发来的报价很有竞争力。'],err:'We received order yesterday. → We received an order yesterday.',gold:'The samples have been sent by express. 样品已通过快递寄出。',
 fill:[{q:'Please send us ___ quotation for 500 units.',a:'a'},{q:'___ samples you sent arrived safely.',a:'The'},{q:'We received ___ order from a new client.',a:'an'}],
 ec:[{q:'We received order yesterday.',a:'We received an order yesterday.'},{q:'Please send us the quotation for the first time.',a:'Please send us a quotation.'}],
 tr:[{q:'请给我们发一份报价单。',a:'Please send us a quotation.'},{q:'样品已通过快递寄出。',a:'The samples have been sent by express.'}]},
{t:'介词 at / in / on',lv:1,r:'时间：at+具体时刻，on+具体某天，in+月份/年份/季节。地点：at+点，in+大范围，on+表面/线路。',ex:['The meeting is on Monday. 会议在周一。','The goods will arrive in July. 货物七月到。'],err:'The meeting is at Monday. → The meeting is on Monday.',gold:'The shipment will arrive at the port on June 15th. 货将于6月15日到港。',
 fill:[{q:'The meeting is ___ Monday morning.',a:'on'},{q:'The goods will arrive ___ July.',a:'in'},{q:'The flight departs ___ 9 a.m.',a:'at'}],
 ec:[{q:'The meeting is at Monday.',a:'The meeting is on Monday.'},{q:'The goods will arrive on July.',a:'The goods will arrive in July.'}],
 tr:[{q:'会议在周一上午。',a:'The meeting is on Monday morning.'},{q:'货将于六月到港。',a:'The shipment will arrive at the port in June.'}]},
{t:'There be 句型',lv:1,r:'There is/are + 名词，表示"存在有"。单数/不可数用 is，复数用 are；过去用 was/were。',ex:['There is a problem with the invoice. 发票有个问题。','There are two items out of stock. 有两项缺货。'],err:'There have two options. → There are two options.',gold:'There is one more point I would like to confirm. 还有一点我想确认一下。',
 fill:[{q:'There ___ (be) a delay in production.',a:'is'},{q:'There ___ (be) several options available.',a:'are'},{q:'There ___ (be) a mistake in the contract yesterday.',a:'was'}],
 ec:[{q:'There have two items out of stock.',a:'There are two items out of stock.'},{q:'There is three problems with the invoice.',a:'There are three problems with the invoice.'}],
 tr:[{q:'发票上有个问题。',a:'There is a problem with the invoice.'},{q:'还有一点我想确认一下。',a:'There is one more point I would like to confirm.'}]},
{t:'情态动词 can / could',lv:1,r:'can 表能力或许可；could 更委婉，是商务沟通的礼貌首选。后接动词原形。',ex:['We can offer a discount for bulk orders. 大单我们可以给折扣。','Could you send us the catalog? 您能发一下目录吗？'],err:'Could you to send the file? → Could you send the file?',gold:'Could you please confirm the delivery date? 您能确认一下交货日期吗？',
 fill:[{q:'We ___ offer a 5% discount for this order. (can)',a:'can'},{q:'___ you please send us the price list?',a:'Could'},{q:'I ___ arrange the shipment next week. (can)',a:'can'}],
 ec:[{q:'Could you to send us the catalog?',a:'Could you send us the catalog?'},{q:'We can offering a discount for bulk orders.',a:'We can offer a discount for bulk orders.'}],
 tr:[{q:'您能确认一下交货日期吗？',a:'Could you please confirm the delivery date?'},{q:'大单我们可以给折扣。',a:'We can offer a discount for bulk orders.'}]},
{t:'祈使句与建议句型',lv:1,r:'祈使句以动词原形开头(Please find attached.)。建议用 Let us / Shall we / How about。',ex:['Please find the contract attached. 合同见附件，请查收。','Let us schedule a call next week. 我们下周安排个电话会议吧。'],err:'Please to check the attachment. → Please check the attachment.',gold:'Please do not hesitate to contact us. 请随时与我们联系。',
 fill:[{q:'___ (find) the updated catalog attached.',a:'Please find'},{q:'___ us schedule a call next week. (let)',a:'Let'},{q:'Please ___ (not hesitate) to contact us anytime.',a:'do not hesitate'}],
 ec:[{q:'Please to check the attachment.',a:'Please check the attachment.'},{q:'Let us to schedule a meeting.',a:'Let us schedule a meeting.'}],
 tr:[{q:'请随时与我们联系。',a:'Please do not hesitate to contact us.'},{q:'我们下周安排个电话会议吧。',a:'Let us schedule a call next week.'}]},
{t:'形容词比较级',lv:1,r:'两者比较用比较级 + than。短词加 -er(cheaper)，长词用 more(more competitive)。注意不规则 better/worse。',ex:['Your price is higher than we expected. 您的价格比我们预期高。','This model is more durable than the old one. 这个型号比旧的更耐用。'],err:'Your price is more higher. → Your price is higher.',gold:'We can offer better quality at the same price. 同样的价格我们能提供更好的质量。',
 fill:[{q:'Your price is ___ (high) than our target.',a:'higher'},{q:'This supplier is ___ (reliable) than the previous one.',a:'more reliable'},{q:'We need a ___ (good) solution. (不规则)',a:'better'}],
 ec:[{q:'Your price is more higher than ours.',a:'Your price is higher than ours.'},{q:'This model is durabler than the old one.',a:'This model is more durable than the old one.'}],
 tr:[{q:'同样的价格我们能提供更好的质量。',a:'We can offer better quality at the same price.'},{q:'您的价格比我们预期高。',a:'Your price is higher than we expected.'}]},
{t:'形容词最高级',lv:1,r:'三者及以上用 the + 最高级。短词加 -est(the lowest)，长词用 the most(the most competitive)。',ex:['This is the most popular model in our line. 这是我们产品线里最畅销的型号。','We offer the lowest price in the market. 我们的价格是市场最低。'],err:'This is most popular model. → This is the most popular model.',gold:'Quality is always the most important factor. 质量永远是最重要的因素。',
 fill:[{q:'This is ___ (competitive) price we can offer.',a:'the most competitive'},{q:'June is our ___ (busy) month of the year.',a:'busiest'},{q:'It is ___ (good) seller in our catalog. (不规则)',a:'the best'}],
 ec:[{q:'This is most popular model in our line.',a:'This is the most popular model in our line.'},{q:'We offer the low price in the market.',a:'We offer the lowest price in the market.'}],
 tr:[{q:'质量永远是最重要的因素。',a:'Quality is always the most important factor.'},{q:'这是我们最畅销的型号。',a:'This is the most popular model in our line.'}]},
{t:'频率副词',lv:1,r:'always/usually/often/sometimes/rarely/never 放在实义动词前、be 动词后。商务中常用于说明惯例。',ex:['We usually reply within 24 hours. 我们通常24小时内回复。','Delays are rarely acceptable. 延误很少能被接受。'],err:'We reply usually within 24 hours. → We usually reply within 24 hours.',gold:'We always inspect the goods before shipment. 我们总是在发货前验货。',
 fill:[{q:'We ___ (usually) reply within 24 hours.',a:'usually'},{q:'The goods ___ (be/always) inspected before shipment.',a:'are always'},{q:'We ___ (never) compromise on quality.',a:'never'}],
 ec:[{q:'We reply usually within 24 hours.',a:'We usually reply within 24 hours.'},{q:'Delays rarely are acceptable.',a:'Delays are rarely acceptable.'}],
 tr:[{q:'我们总是在发货前验货。',a:'We always inspect the goods before shipment.'},{q:'我们通常24小时内回复。',a:'We usually reply within 24 hours.'}]},
// ---- Level 2 ----
{t:'现在完成时',lv:2,r:'have/has + 过去分词。连接过去与现在：已完成且与现在相关，或从过去持续至今(常配 for/since/already/yet)。',ex:['We have received your payment. 我们已收到您的付款。','The goods have been shipped. 货物已发出。'],err:'We have received the goods yesterday. → We received the goods yesterday. (有具体过去时间用一般过去时)',gold:'We have already arranged the shipment. 我们已经安排了发货。',
 fill:[{q:'We ___ (receive) your payment already.',a:'have received'},{q:'The samples ___ (arrive) safely.',a:'have arrived'},{q:'I ___ (work) in this industry for ten years.',a:'have worked'}],
 ec:[{q:'We have received the goods yesterday.',a:'We received the goods yesterday.'},{q:'The goods has been shipped.',a:'The goods have been shipped.'}],
 tr:[{q:'我们已经安排了发货。',a:'We have already arranged the shipment.'},{q:'我们已收到您的付款。',a:'We have received your payment.'}]},
{t:'过去进行时',lv:2,r:'was/were + 动词-ing。表示过去某时刻正在进行，常与 when 引导的短暂动作搭配。',ex:['We were inspecting the goods when the client called. 客户来电时我们正在验货。','They were negotiating the price at that time. 那时他们正在谈价。'],err:'We were inspect when you called. → We were inspecting when you called.',gold:'I was reviewing the contract when I noticed the error. 我在审合同时发现了这个错误。',
 fill:[{q:'We ___ (inspect) the goods when the client called.',a:'were inspecting'},{q:'They ___ (negotiate) the price at that moment.',a:'were negotiating'},{q:'I ___ (review) the contract when I found the error.',a:'was reviewing'}],
 ec:[{q:'We were inspect the goods when you called.',a:'We were inspecting the goods when you called.'},{q:'They was negotiating at that time.',a:'They were negotiating at that time.'}],
 tr:[{q:'我在审合同时发现了这个错误。',a:'I was reviewing the contract when I noticed the error.'},{q:'客户来电时我们正在验货。',a:'We were inspecting the goods when the client called.'}]},
{t:'一般将来时 will / be going to',lv:2,r:'will 表临时决定、承诺、预测；be going to 表事先计划。商务承诺常用 will。',ex:['We will arrange the shipment next week. 我们下周安排发货。','We are going to launch a new model in June. 我们计划六月发布新型号。'],err:'I will to send the file. → I will send the file.',gold:'We will do our best to meet your requirements. 我们会尽力满足您的要求。',
 fill:[{q:'We ___ (arrange) the shipment next Friday. (承诺)',a:'will arrange'},{q:'We ___ (launch) a new model next quarter. (计划)',a:'are going to launch'},{q:'I ___ (send) you the details right away. (临时决定)',a:'will send'}],
 ec:[{q:'I will to send you the details.',a:'I will send you the details.'},{q:'We going to launch a new model in June.',a:'We are going to launch a new model in June.'}],
 tr:[{q:'我们会尽力满足您的要求。',a:'We will do our best to meet your requirements.'},{q:'我们计划六月发布新型号。',a:'We are going to launch a new model in June.'}]},
{t:'被动语态（基础）',lv:2,r:'be + 过去分词。强调动作的承受者而非执行者。商务文件中高频使用，显得客观正式。',ex:['The goods have been shipped. 货物已发出。','The invoice was issued yesterday. 发票昨天已开具。'],err:'The goods have been ship. → The goods have been shipped.',gold:'Your order is being processed. 您的订单正在处理中。',
 fill:[{q:'The goods ___ (ship) yesterday.',a:'were shipped'},{q:'The invoice ___ (issue) last week.',a:'was issued'},{q:'Your order ___ (process) now.',a:'is being processed'}],
 ec:[{q:'The goods have been ship.',a:'The goods have been shipped.'},{q:'The invoice issued yesterday by us.',a:'The invoice was issued yesterday.'}],
 tr:[{q:'您的订单正在处理中。',a:'Your order is being processed.'},{q:'货物已发出。',a:'The goods have been shipped.'}]},
{t:'第一条件句 (if)',lv:2,r:'If + 一般现在时, 主句 will + 动词原形。表示真实可能发生的条件。谈判中提条件必备。',ex:['If you order 1,000 units, we will offer a 10% discount. 订1000件我们给9折。','If the price is acceptable, we will place the order. 价格合适我们就下单。'],err:'If you will order 1,000 units... → If you order 1,000 units...',gold:'If you confirm today, we can ship this week. 今天确认的话，我们本周就能发货。',
 fill:[{q:'If you ___ (order) 1,000 units, we will offer a discount.',a:'order'},{q:'If the price ___ (be) acceptable, we will confirm.',a:'is'},{q:'We ___ (ship) this week if you confirm today.',a:'will ship'}],
 ec:[{q:'If you will order 1,000 units, we will offer a discount.',a:'If you order 1,000 units, we will offer a discount.'},{q:'If the price is acceptable, we place the order.',a:'If the price is acceptable, we will place the order.'}],
 tr:[{q:'今天确认的话，我们本周就能发货。',a:'If you confirm today, we can ship this week.'},{q:'订1000件我们给9折。',a:'If you order 1,000 units, we will offer a 10% discount.'}]},
{t:'情态动词 must / have to',lv:2,r:'must 表强烈义务或规定；have to 表客观需要。否定 must not = 禁止；do not have to = 不必。',ex:['The goods must be inspected before shipment. 货物发货前必须检验。','We have to pay a 30% deposit first. 我们得先付30%定金。'],err:'You must to sign here. → You must sign here.',gold:'All products must pass quality inspection. 所有产品必须通过质检。',
 fill:[{q:'The goods must ___ (inspect) before shipment.',a:'be inspected'},{q:'We ___ (have to) pay the deposit first.',a:'have to'},{q:'All products must ___ (pass) quality inspection.',a:'pass'}],
 ec:[{q:'You must to sign here.',a:'You must sign here.'},{q:'We have to paying the deposit first.',a:'We have to pay the deposit first.'}],
 tr:[{q:'所有产品必须通过质检。',a:'All products must pass quality inspection.'},{q:'我们得先付30%定金。',a:'We have to pay a 30% deposit first.'}]},
{t:'情态动词 should / may / might',lv:2,r:'should 表建议；may/might 表可能性(might 更弱)。商务中表达推测和委婉建议的利器。',ex:['You should check the contract carefully. 您应该仔细核对合同。','The shipment might be delayed due to the holiday. 因假期货可能延迟。'],err:'You should to check it. → You should check it.',gold:'We may need to adjust the delivery schedule. 我们可能需要调整交货计划。',
 fill:[{q:'You should ___ (check) the contract carefully.',a:'check'},{q:'The shipment ___ (may) be delayed.',a:'may'},{q:'We ___ (might) need more time for production.',a:'might'}],
 ec:[{q:'You should to check the contract carefully.',a:'You should check the contract carefully.'},{q:'The shipment might being delayed.',a:'The shipment might be delayed.'}],
 tr:[{q:'我们可能需要调整交货计划。',a:'We may need to adjust the delivery schedule.'},{q:'因假期货可能会延迟。',a:'The shipment might be delayed due to the holiday.'}]},
{t:'关系从句 who / which / that',lv:2,r:'who 指人，which 指物，that 两者皆可(限定性从句)。从句紧跟被修饰的名词。',ex:['The manager who handles your account is on leave. 负责您账户的经理在休假。','The products which we ordered have arrived. 我们订的货到了。'],err:'The products who we ordered... → The products which we ordered...',gold:'This is the supplier that we have worked with for years. 这就是我们合作多年的供应商。',
 fill:[{q:'The manager ___ handles your account is on leave.',a:'who'},{q:'The products ___ we ordered have arrived.',a:'which'},{q:'This is the supplier ___ we trust most.',a:'that'}],
 ec:[{q:'The products who we ordered have arrived.',a:'The products which we ordered have arrived.'},{q:'The manager which handles your account is on leave.',a:'The manager who handles your account is on leave.'}],
 tr:[{q:'这就是我们合作多年的供应商。',a:'This is the supplier that we have worked with for years.'},{q:'我们订的货已经到了。',a:'The products which we ordered have arrived.'}]},
{t:'动名词 (V-ing 作名词)',lv:2,r:'动词-ing 可作主语/宾语。常见搭配：look forward to doing, be used to doing, suggest doing。',ex:['We look forward to hearing from you. 期待您的回音。','We suggest arranging the shipment in advance. 我们建议提前安排发货。'],err:'We look forward to hear from you. → We look forward to hearing from you.',gold:'Thank you for choosing our products. 感谢您选择我们的产品。',
 fill:[{q:'We look forward to ___ (hear) from you.',a:'hearing'},{q:'We suggest ___ (arrange) the shipment in advance.',a:'arranging'},{q:'Thank you for ___ (choose) our products.',a:'choosing'}],
 ec:[{q:'We look forward to hear from you.',a:'We look forward to hearing from you.'},{q:'We suggest to arrange the shipment in advance.',a:'We suggest arranging the shipment in advance.'}],
 tr:[{q:'期待您的回音。',a:'We look forward to hearing from you.'},{q:'感谢您选择我们的产品。',a:'Thank you for choosing our products.'}]},
{t:'不定式 (to do)',lv:2,r:'to + 动词原形，表目的或接在特定动词后(want/hope/decide/allow)。表目的可译为"为了"。',ex:['We decided to extend the warranty period. 我们决定延长保修期。','To ensure quality, we inspect every batch. 为保证质量，我们检验每一批。'],err:'We decided to extending the warranty. → We decided to extend the warranty.',gold:'We are pleased to inform you that your order has been confirmed. 很高兴通知您，订单已确认。',
 fill:[{q:'We decided ___ (extend) the warranty period.',a:'to extend'},{q:'___ (ensure) quality, we inspect every batch.',a:'To ensure'},{q:'We are pleased ___ (inform) you of the good news.',a:'to inform'}],
 ec:[{q:'We decided to extending the warranty period.',a:'We decided to extend the warranty period.'},{q:'For ensure quality, we inspect every batch.',a:'To ensure quality, we inspect every batch.'}],
 tr:[{q:'很高兴通知您，订单已确认。',a:'We are pleased to inform you that your order has been confirmed.'},{q:'为保证质量，我们检验每一批。',a:'To ensure quality, we inspect every batch.'}]},
{t:'现在完成进行时',lv:2,r:'have/has been + V-ing。强调从过去持续到现在并可能继续的动作，常配 for/since。',ex:['We have been working with this supplier for five years. 我们与这家供应商合作五年了。','They have been negotiating since Monday. 他们从周一谈到现在。'],err:'We have been work with them for years. → We have been working with them for years.',gold:'We have been serving clients in over 30 countries. 我们一直为30多个国家的客户服务。',
 fill:[{q:'We ___ (work) with this supplier for five years.',a:'have been working'},{q:'They ___ (negotiate) since Monday.',a:'have been negotiating'},{q:'Our company ___ (serve) overseas clients since 2010.',a:'has been serving'}],
 ec:[{q:'We have been work with them for years.',a:'We have been working with them for years.'},{q:'They has been negotiating since Monday.',a:'They have been negotiating since Monday.'}],
 tr:[{q:'我们与这家供应商合作五年了。',a:'We have been working with this supplier for five years.'},{q:'我们一直为30多个国家的客户服务。',a:'We have been serving clients in over 30 countries.'}]},
{t:'反意疑问句',lv:2,r:'陈述句 + 简短反问。前肯后否，前否后肯。口语确认信息时自然好用。',ex:['The shipment arrives on Friday, doesn\'t it? 货周五到，对吧？','You haven\'t received the invoice, have you? 您还没收到发票，对吗？'],err:'The goods arrived, didn\'t they? 若主语单数 → didn\'t it.',gold:'You could send us the details today, couldn\'t you? 您今天能发细节给我们，对吧？',
 fill:[{q:'The shipment arrives on Friday, ___ it?',a:"doesn't"},{q:'You haven\'t received the invoice, ___ you?',a:'have'},{q:'We agreed on this price, ___ we?',a:"didn't"}],
 ec:[{q:'The shipment arrives on Friday, does it?',a:"The shipment arrives on Friday, doesn't it?"},{q:'You have received the invoice, have you?',a:"You haven't received the invoice, have you?"}],
 tr:[{q:'货周五到，对吧？',a:"The shipment arrives on Friday, doesn't it?"},{q:'您还没收到发票，对吗？',a:"You haven't received the invoice, have you?"}]},
// ---- Level 3 ----
{t:'虚拟语气（与现在相反）',lv:3,r:'If + 过去时, would + 动词原形。表示与现在事实相反的假设。谈判中委婉试探常用。',ex:['If the price were lower, we would order more. 价格再低些我们会多订。','If we had more stock, we would ship immediately. 有库存我们马上就发。'],err:'If the price was lower (正式文体应用 were) → If the price were lower.',gold:'We would appreciate it if you could reply soon. 若能尽快回复，我们将不胜感激。',
 fill:[{q:'If the price ___ (be) lower, we would order more.',a:'were'},{q:'If we ___ (have) more stock, we would ship immediately.',a:'had'},{q:'We ___ (appreciate) it if you could reply soon.',a:'would appreciate'}],
 ec:[{q:'If the price was lower, we would order more.',a:'If the price were lower, we would order more.'},{q:'If we would have more stock, we would ship immediately.',a:'If we had more stock, we would ship immediately.'}],
 tr:[{q:'若能尽快回复，我们将不胜感激。',a:'We would appreciate it if you could reply soon.'},{q:'价格再低些我们会多订。',a:'If the price were lower, we would order more.'}]},
{t:'虚拟语气（与过去相反）',lv:3,r:'If + had done, would have done。对过去的假设与遗憾。复盘和解释问题时用。',ex:['If we had known earlier, we would have adjusted the schedule. 早知道我们就调整日程了。','If you had confirmed on time, the goods would have arrived. 按时确认货就到了。'],err:'If we would have known... → If we had known...',gold:'We could have avoided the delay if we had acted earlier. 早点行动就能避免延误。',
 fill:[{q:'If we ___ (know) earlier, we would have adjusted the schedule.',a:'had known'},{q:'The goods would have arrived if you ___ (confirm) on time.',a:'had confirmed'},{q:'We ___ (avoid) the delay if we had acted earlier.',a:'could have avoided'}],
 ec:[{q:'If we would have known earlier, we would have adjusted.',a:'If we had known earlier, we would have adjusted.'},{q:'The goods would have arrived if you confirmed on time.',a:'The goods would have arrived if you had confirmed on time.'}],
 tr:[{q:'早知道我们就调整日程了。',a:'If we had known earlier, we would have adjusted the schedule.'},{q:'早点行动就能避免延误。',a:'We could have avoided the delay if we had acted earlier.'}]},
{t:'条件句综合辨析',lv:3,r:'第一条件句(真实可能): If + 现在, will。第二条件句(现在假设): If + 过去, would。第三条件句(过去假设): If + had done, would have done。',ex:['If you order now, we will ship today. 现在订今天发。','If you ordered more, we would give a discount. 多订就有折扣。'],err:'If you will order now → If you order now.',gold:'Should you have any questions, please feel free to contact us. 如有任何问题，请随时联系。(倒装条件句)', 
 fill:[{q:'If you ___ (order) now, we will ship today.',a:'order'},{q:'If you ___ (order) more, we would give a discount.',a:'ordered'},{q:'___ you have any questions, please contact us. (倒装)',a:'Should'}],
 ec:[{q:'If you will order now, we will ship today.',a:'If you order now, we will ship today.'},{q:'Should you will have questions, contact us.',a:'Should you have any questions, please contact us.'}],
 tr:[{q:'如有任何问题，请随时联系。',a:'Should you have any questions, please feel free to contact us.'},{q:'多订的话我们会给折扣。',a:'If you ordered more, we would give a discount.'}]},
{t:'倒装句（否定词开头）',lv:3,r:'Never/Seldom/Rarely/Not only 置于句首时，主句主谓部分倒装，增强语气。正式商务函电增彩。',ex:['Never have we compromised on quality. 我们从未在质量上妥协。','Not only did we meet the deadline, but we also cut costs. 我们不仅赶上期限还降了成本。'],err:'Never we have compromised. → Never have we compromised.',gold:'Under no circumstances should the goods be shipped without inspection. 任何情况下都不得未经检验发货。',
 fill:[{q:'Never ___ we ___ (compromise) on quality.',a:'have compromised'},{q:'Not only ___ we ___ (meet) the deadline, but we also cut costs.',a:'did meet'},{q:'Rarely ___ (do) we offer such a discount.',a:'do'}],
 ec:[{q:'Never we have compromised on quality.',a:'Never have we compromised on quality.'},{q:'Not only we met the deadline, but we also cut costs.',a:'Not only did we meet the deadline, but we also cut costs.'}],
 tr:[{q:'我们从未在质量上妥协。',a:'Never have we compromised on quality.'},{q:'任何情况下都不得未经检验发货。',a:'Under no circumstances should the goods be shipped without inspection.'}]},
{t:'分词结构作状语',lv:3,r:'现在分词(主动)或过去分词(被动)开头作状语，精简主从句。书面报告、邮件中让句子更紧凑专业。',ex:['Considering your order quantity, we offer a 5% discount. 考虑到订量，我们给5%折扣。','Made of stainless steel, the product is very durable. 不锈钢制造，非常耐用。'],err:'Being made of steel, the durability is good. → Being made of steel, the product is durable. (分词逻辑主语须一致)',gold:'Looking forward to your reply, we remain at your service. 期待您的回复，随时为您服务。',
 fill:[{q:'___ (consider) your order quantity, we offer a 5% discount.',a:'Considering'},{q:'___ (make) of stainless steel, the product is durable.',a:'Made'},{q:'___ (look) forward to your reply, we remain at your service.',a:'Looking'}],
 ec:[{q:'Being made of steel, the durability is excellent.',a:'Being made of steel, the product is very durable.'},{q:'Considered your order quantity, we offer a discount.',a:'Considering your order quantity, we offer a discount.'}],
 tr:[{q:'考虑到订量，我们给5%折扣。',a:'Considering your order quantity, we offer a 5% discount.'},{q:'不锈钢制造，这款产品非常耐用。',a:'Made of stainless steel, the product is very durable.'}]},
{t:'过去完成时',lv:3,r:'had + 过去分词。表示"过去的过去"。叙述事件先后时理清时间线。',ex:['We had shipped the goods before the holiday began. 假期前我们就发货了。','The client had paid the deposit before production started. 生产前客户已付定金。'],err:'We shipped the goods before the holiday began 也可接受，但强调先后用 had shipped 更严谨。',gold:'By the time you confirmed, we had already started production. 您确认时我们已开始生产。',
 fill:[{q:'We ___ (ship) the goods before the holiday began.',a:'had shipped'},{q:'The client ___ (pay) the deposit before production started.',a:'had paid'},{q:'By the time you confirmed, we ___ (start) production.',a:'had started'}],
 ec:[{q:'We have shipped the goods before the holiday began.',a:'We had shipped the goods before the holiday began.'},{q:'The client had pay the deposit before production started.',a:'The client had paid the deposit before production started.'}],
 tr:[{q:'假期前我们就发货了。',a:'We had shipped the goods before the holiday began.'},{q:'您确认时我们已开始生产。',a:'By the time you confirmed, we had already started production.'}]},
{t:'将来完成时',lv:3,r:'will have + 过去分词。表示到将来某时已完成。给客户的交期承诺加分句型。',ex:['We will have completed production by Friday. 周五前我们将完成生产。','The goods will have arrived by the end of June. 六月底前货将到达。'],err:'We will completed by Friday. → We will have completed by Friday.',gold:'We will have finished the inspection before your visit. 您来访前我们将完成检验。',
 fill:[{q:'We ___ (complete) production by Friday.',a:'will have completed'},{q:'The goods ___ (arrive) by the end of June.',a:'will have arrived'},{q:'We ___ (finish) the inspection before your visit.',a:'will have finished'}],
 ec:[{q:'We will completed production by Friday.',a:'We will have completed production by Friday.'},{q:'The goods will arrived by the end of June.',a:'The goods will have arrived by the end of June.'}],
 tr:[{q:'周五前我们将完成生产。',a:'We will have completed production by Friday.'},{q:'您来访前我们将完成检验。',a:'We will have finished the inspection before your visit.'}]},
{t:'被动语态进阶（含情态动词）',lv:3,r:'情态动词 + be + 过去分词：can be arranged, must be inspected, should be confirmed。商务高频。',ex:['The shipment can be arranged next week. 发货可安排在下周。','The details must be confirmed before signing. 签署前必须确认细节。'],err:'The shipment can arranged. → The shipment can be arranged.',gold:'Payment should be made within 30 days of the invoice date. 应在发票日期后30天内付款。',
 fill:[{q:'The shipment can ___ (arrange) next week.',a:'be arranged'},{q:'The details must ___ (confirm) before signing.',a:'be confirmed'},{q:'Payment should ___ (make) within 30 days.',a:'be made'}],
 ec:[{q:'The shipment can arranged next week.',a:'The shipment can be arranged next week.'},{q:'The details must confirming before signing.',a:'The details must be confirmed before signing.'}],
 tr:[{q:'应在发票日期后30天内付款。',a:'Payment should be made within 30 days of the invoice date.'},{q:'发货可安排在下周。',a:'The shipment can be arranged next week.'}]},
{t:'强调句 It is ... that',lv:3,r:'It is/was + 被强调部分 + that + 其余。突出关键信息，邮件中强调重点时使用。',ex:['It is the quality that matters most. 最重要的是质量。','It was in June that we launched the product. 我们是六月发布的产品。'],err:'It is the quality what matters. → It is the quality that matters.',gold:'It is your support that keeps us moving forward. 是您的支持让我们不断前进。',
 fill:[{q:'It is the quality ___ matters most.',a:'that'},{q:'It was in June ___ we launched the product.',a:'that'},{q:'It is your support ___ keeps us moving forward.',a:'that'}],
 ec:[{q:'It is the quality what matters most.',a:'It is the quality that matters most.'},{q:'It was in June when we launched the product.',a:'It was in June that we launched the product.'}],
 tr:[{q:'最重要的是质量。',a:'It is the quality that matters most.'},{q:'是您的支持让我们不断前进。',a:'It is your support that keeps us moving forward.'}]},
{t:'名词性从句（宾语从句）',lv:3,r:'动词后接 that/whether/what 从句作宾语。注意语序为陈述语序，不倒装。',ex:['We believe that quality comes first. 我们相信质量第一。','Please let us know whether you accept the terms. 请告知是否接受条款。'],err:'Could you tell me where is the warehouse? → Could you tell me where the warehouse is?',gold:'We would like to confirm that the order has been received. 我们想确认订单已收到。',
 fill:[{q:'We believe ___ quality comes first.',a:'that'},{q:'Please let us know ___ you accept the terms.',a:'whether'},{q:'Could you tell me where the warehouse ___ (be)?',a:'is'}],
 ec:[{q:'Could you tell me where is the warehouse?',a:'Could you tell me where the warehouse is?'},{q:'We believe what quality comes first.',a:'We believe that quality comes first.'}],
 tr:[{q:'请告知是否接受条款。',a:'Please let us know whether you accept the terms.'},{q:'我们想确认订单已收到。',a:'We would like to confirm that the order has been received.'}]},
{t:'定语从句进阶 whose / where / when',lv:3,r:'whose 表所属；where 指地点(=in which)；when 指时间。让描述更精确。',ex:['The supplier whose products we ordered is reliable. 我们订货的那家供应商很可靠。','The warehouse where the goods are stored is near the port. 存货的仓库在港口附近。'],err:'The supplier who\'s products... → The supplier whose products...',gold:'The market where we operate is highly competitive. 我们所在的市场竞争激烈。',
 fill:[{q:'The supplier ___ products we ordered is reliable.',a:'whose'},{q:'The warehouse ___ the goods are stored is near the port.',a:'where'},{q:'Do you remember the date ___ we signed the contract?',a:'when'}],
 ec:[{q:"The supplier who's products we ordered is reliable.",a:'The supplier whose products we ordered is reliable.'},{q:'The warehouse which the goods are stored is near the port.',a:'The warehouse where the goods are stored is near the port.'}],
 tr:[{q:'我们所在的市场竞争激烈。',a:'The market where we operate is highly competitive.'},{q:'存货的仓库在港口附近。',a:'The warehouse where the goods are stored is near the port.'}]},
{t:'商务长句拆解',lv:3,r:'长句三步拆：①找主谓宾主干 ②圈出从句引导词 ③把介词短语/分词结构括起来。先抓骨架再看修饰。',ex:['The products (which we ordered last month) will be shipped (after the inspection) next Friday. 主干：The products will be shipped.','We believe (that the delay was caused by the holiday) and (that production will resume soon). 主干：We believe...'],err:'逐词翻译长句 → 先找主干再处理修饰。',gold:'Please find attached the report, which summarizes the results of the market research we conducted last quarter. 请查收附件报告。',
 fill:[{q:'找主干：The quotation that you requested yesterday has been sent. 主干动词是 ___',a:'has been sent'},{q:'引导词：The goods which arrived last week passed inspection. 从句引导词是 ___',a:'which'},{q:'括修饰：We will arrange the shipment after receiving the deposit. 分词结构首词是 ___',a:'after'}],
 ec:[{q:'We believe that the delay was caused by the holiday and production will resume soon 中无语法错误。',a:'此句无错，主干为 We believe that... and (that)...'},{q:'Please find attached the report which summarizes the results 中无语法错误。',a:'此句无错，which 引导定语从句修饰 report。'}],
 tr:[{q:'请查收附件中的市场研究报告。',a:'Please find attached the market research report.'},{q:'我们认为延误是假期造成的，生产很快会恢复。',a:'We believe that the delay was caused by the holiday and that production will resume soon.'}]}
];

const SPEAKING_BANK = [
  {scene:'客户询价电话',setup:'客户来电询问产品价格和起订量',lines:['Thank you for calling. May I have your company name?','Our MOQ is 500 units with a unit price of $12.','If you order more than 1,000 units, we can offer a 10% discount.','I will send you the quotation by email right after this call.']},
  {scene:'展会接待客户',setup:'在展会上接待一位对您产品感兴趣的外国客户',lines:['Welcome to our booth. Please feel free to look around.','This is our best-selling model in the European market.','Would you like me to show you how it works?','May I have your business card so we can follow up?']},
  {scene:'交货延迟道歉',setup:'因生产问题交货延迟，致电客户解释',lines:['I am calling to inform you about a delay in your shipment.','The delay was caused by a shortage of raw materials.','We expect to ship within one week.','We sincerely apologize for the inconvenience.']},
  {scene:'价格谈判',setup:'与客户就价格进行谈判',lines:['We understand your concern about the price.','However, this is already our best offer for this quality.','How about we meet halfway on the quantity instead?','Let me check with my manager and get back to you.']},
  {scene:'安排商务会议',setup:'与国外客户约定视频会议时间',lines:['I would like to schedule a video call to discuss the details.','Would next Tuesday at 3 p.m. Beijing time work for you?','I will send you the meeting link by email.','Looking forward to speaking with you then.']},
  {scene:'产品质量投诉处理',setup:'客户投诉部分产品有瑕疵',lines:['I am sorry to hear about the quality issue.','Could you send us photos of the defective items?','We will investigate immediately and find a solution.','We can arrange replacement or a refund as you prefer.']}
];

const ARTICLE_BANK = [
  {title:'How to Write a Professional Business Email',text:'Writing a professional business email is a key skill in international trade. Start with a clear subject line that summarizes your purpose. Open with a polite greeting and get to the point quickly. In the first paragraph, state why you are writing. In the middle, provide the necessary details, such as order numbers, dates, or requirements. Keep sentences short and direct. Avoid slang and overly casual expressions. Close with a clear call to action, telling the reader exactly what you need from them and by when. Finally, end with a courteous sign-off such as "Best regards" followed by your full name and company details. Proofread carefully before sending, because small errors can damage your professional image.'},
  {title:'The Basics of International Trade Terms',text:'When doing business across borders, trade terms define who is responsible for costs and risks at each stage of shipping. The most common terms are FOB and CIF. Under FOB, or Free On Board, the seller delivers the goods onto the ship, and the buyer takes responsibility from that point. Under CIF, or Cost, Insurance and Freight, the seller pays for shipping and insurance to the destination port. Choosing the right term affects your pricing, risk, and cash flow. New exporters often prefer CIF because it gives them more control over logistics. Whatever terms you choose, always state them clearly in the contract to avoid disputes later.'},
  {title:'Five Habits of Successful Negotiators',text:'Successful negotiators share several common habits. First, they prepare thoroughly, researching the other party and knowing their own bottom line. Second, they listen more than they talk, because understanding the other side\'s real needs creates room for agreement. Third, they stay calm under pressure and never make decisions out of anger. Fourth, they look for win-win solutions instead of trying to defeat the other party, which builds long-term relationships. Finally, they always summarize agreements in writing at the end of the discussion. These habits apply whether you are negotiating a small order or a million-dollar contract.'},
  {title:'Why Customer Feedback Matters',text:'Customer feedback is one of the most valuable resources for any business. It tells you what is working and what needs improvement. Companies that actively collect feedback can fix small problems before they become big ones. There are many ways to gather feedback: follow-up emails after delivery, short surveys, or direct phone calls for key clients. When you receive negative feedback, respond quickly and professionally. Thank the customer for pointing out the issue, explain what you will do about it, and follow up afterwards. Customers who feel heard are more likely to stay loyal, even after a problem occurs.'}
];

// ========================================
// HELPERS: daily pickers
// ========================================
function getDailyGrammar(idx){ return GRAMMAR_BANK[idx % GRAMMAR_BANK.length]; }
function getDailyVocab(idx){
  const themeIdx = idx % VOCAB_THEMES.length;
  return VOCAB_BANK.filter(v=>v.t===themeIdx);
}
function getDailySpeaking(idx){ return SPEAKING_BANK[idx % SPEAKING_BANK.length]; }
function getDailyArticle(idx){ return ARTICLE_BANK[idx % ARTICLE_BANK.length]; }
function grammarLevelName(lv){ return lv===1?'基础级':lv===2?'进阶级':'高级'; }

function ensureEngContent(dateStr) {
  if (getS('engStart','') === '') setS('engStart', dateStr);
  const idx = getDayIndex(dateStr);
  const existing = DATA.engTasks.filter(t=>t.date===dateStr);
  if (existing.length === 0) {
    const g = getDailyGrammar(idx);
    const v = getDailyVocab(idx);
    const s = getDailySpeaking(idx);
    const a = getDailyArticle(idx);
    DATA.engTasks.push({id:uid(),date:dateStr,type:'grammar',content:JSON.stringify({t:g.t,lv:g.lv,r:g.r,ex:g.ex,err:g.err,gold:g.gold}),answer:'',review:'',done:false});
    DATA.engTasks.push({id:uid(),date:dateStr,type:'practice',content:JSON.stringify({title:g.t,fill:g.fill,ec:g.ec,tr:g.tr}),answer:'',review:'',done:false});
    DATA.engTasks.push({id:uid(),date:dateStr,type:'vocab',content:JSON.stringify(v),answer:'',review:'',done:false});
    DATA.engTasks.push({id:uid(),date:dateStr,type:'speaking',content:JSON.stringify(s),answer:'',review:'',done:false});
    DATA.engTasks.push({id:uid(),date:dateStr,type:'article',content:JSON.stringify(a),answer:'',review:'',done:false});
    saveData();
  }
}

// ========================================
// ANKI (SM-2)
// ========================================
function addAnkiCard(front, back, sub, source) {
  front = String(front||'').trim();
  if (!front) return false;
  if (DATA.ankiCards.some(c=>c.front.toLowerCase()===front.toLowerCase())) return false;
  DATA.ankiCards.push({id:uid(),front,back:back||'',sub:sub||'',source:source||'vocab',createdAt:today(),due:today(),interval:0,ease:2.5,reps:0,lapses:0});
  saveData();
  return true;
}
function getDueCards(dateStr){
  return DATA.ankiCards.filter(c=>c.due<=dateStr);
}
function reviewAnkiCard(cardId, rating) {
  // rating: 0 again, 1 hard, 2 good, 3 easy
  const c = DATA.ankiCards.find(x=>x.id===cardId);
  if (!c) return;
  const td = today();
  if (rating===0) {
    c.lapses++;
    c.reps = 0;
    c.interval = 1;
    c.ease = Math.max(1.3, c.ease - 0.2);
  } else if (rating===1) {
    c.interval = Math.max(1, Math.round((c.interval||1)*1.2));
    c.ease = Math.max(1.3, c.ease - 0.15);
    c.reps++;
  } else if (rating===2) {
    if (c.reps===0) c.interval = 1;
    else if (c.reps===1) c.interval = 3;
    else c.interval = Math.round((c.interval||1)*c.ease);
    c.reps++;
  } else {
    c.interval = Math.round((c.interval||1)*c.ease*1.3)+1;
    c.ease = c.ease + 0.15;
    c.reps++;
  }
  c.due = addDays(td, c.interval);
  saveData();
}
function ankiSourceLabel(s){ return s==='vocab'?'词汇':s==='error'?'错题':s==='reading'?'阅读':'其他'; }

// ========================================
// AI API
// ========================================
async function callAI(messages, onChunk) {
  const key = getS('apiKey','');
  const endpoint = getS('apiEndpoint','https://api.deepseek.com');
  const model = getS('model','deepseek-chat');
  if (!key) return {error:'请先在设置中配置 API Key'};
  // 兼容历史脏数据：旧版曾把 assistant 误存为 'ai'，发送前统一清洗
  messages = (messages||[]).map(m => ({...m, role:(m.role==='ai'?'assistant':m.role)}));
  try {
    const resp = await fetch(endpoint+'/chat/completions', {
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify({model,messages,temperature:0.7,stream:!!onChunk})
    });
    if (!resp.ok) {
      const e = await resp.text();
      return {error:'API 错误 ('+resp.status+'): '+e.slice(0,200)};
    }
    if (onChunk) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const {done,value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value,{stream:true});
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const d = line.slice(6).trim();
            if (d==='[DONE]') continue;
            try {
              const j = JSON.parse(d);
              const txt = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content || '';
              if (txt) onChunk(txt);
            } catch(e){}
          }
        }
      }
      return {ok:true};
    } else {
      const j = await resp.json();
      return {content:(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||'',ok:true};
    }
  } catch(e) {
    let m = '网络错误: '+e.message;
    if (e && (e.message||'').indexOf('Failed to fetch') >= 0) {
      m = '连接失败（CORS/跨域被拦截或网络不通）：无法访问 '+endpoint+'。\n若页面部署在云端域名、而中转站未允许该域名跨域，浏览器会拦截请求。可改用本地打开 index.html，或更换允许跨域的中转站。';
    } else if (e && (e.message||'').indexOf('CORS') >= 0) {
      m = '跨域(CORS)被拦截：中转站 '+endpoint+' 未允许当前页面域名访问。请在 setting 增加 Access-Control-Allow-Origin，或改用同源代理/本地打开。';
    }
    return {error:m};
  }
}

// 用设置弹窗当前填写值实时测试连接（不依赖是否已保存）
async function testAIConnection() {
  const key = $('setKey').value.trim();
  const ep = $('setEndpoint').value.trim() || 'https://api.deepseek.com';
  const model = $('setModel').value;
  const btn = $('testAiBtn'), out = $('testAiOut');
  if (!key) { out.textContent = '请先在上方填写 API Key 再测试'; out.className = 'test-out err'; return; }
  btn.disabled = true; btn.textContent = '测试中...';
  out.textContent = ''; out.className = 'test-out';
  try {
    const resp = await fetch(ep + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], stream: false })
    });
    if (!resp.ok) {
      const t = await resp.text();
      out.textContent = '连接失败（HTTP ' + resp.status + '）：' + t.slice(0, 160);
      out.className = 'test-out err';
    } else {
      const j = await resp.json();
      const ok = !!(j.choices && j.choices[0] && j.choices[0].message);
      out.textContent = ok ? ('连接成功！模型 ' + model + ' 可用。') : ('连接成功但返回异常：' + JSON.stringify(j).slice(0, 120));
      out.className = 'test-out ' + (ok ? 'ok' : 'err');
    }
  } catch (e) {
    let m = '连接失败：' + e.message;
    if (e && (e.message || '').indexOf('Failed to fetch') >= 0) m += '（典型原因：跨域 CORS 被拦截，或当前网络无法访问该中转站）';
    else if (e && (e.message || '').indexOf('CORS') >= 0) m += '（中转站未允许当前页面域名跨域）';
    out.textContent = m;
    out.className = 'test-out err';
  }
  btn.disabled = false; btn.textContent = '测试连接';
}
async function testVisionConnection() {
  const key = $('setVisionKey').value.trim();
  const ep = $('setVisionEndpoint').value.trim() || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const model = $('setVisionModel').value;
  const btn = $('testVisionBtn'), out = $('testVisionOut');
  if (!key) { out.textContent = '请先填写视觉 API Key 再测试'; out.className = 'test-out err'; return; }
  btn.disabled = true; btn.textContent = '测试中...';
  out.textContent = ''; out.className = 'test-out';
  try {
    // 用一张 32x32 红色 PNG 探通，验证密钥与跨域是否可用
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==';
    const resp = await fetch(ep + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }, { type: 'image_url', image_url: { url: png } }] }], stream: false })
    });
    if (!resp.ok) {
      const t = await resp.text();
      out.textContent = '视觉连接失败（HTTP ' + resp.status + '）：' + t.slice(0, 160);
      out.className = 'test-out err';
    } else {
      const j = await resp.json();
      const ok = !!(j.choices && j.choices[0] && j.choices[0].message);
      out.textContent = ok ? ('视觉连接成功！模型 ' + model + ' 可用，拍照识别已就绪。') : ('连接成功但返回异常：' + JSON.stringify(j).slice(0, 120));
      out.className = 'test-out ' + (ok ? 'ok' : 'err');
    }
  } catch (e) {
    let m = '视觉连接失败：' + e.message;
    if (e && (e.message || '').indexOf('Failed to fetch') >= 0) m += '（典型原因：跨域 CORS 被拦截，或当前网络无法访问该接口）';
    else if (e && (e.message || '').indexOf('CORS') >= 0) m += '（该接口未允许当前页面域名跨域）';
    out.textContent = m;
    out.className = 'test-out err';
  }
  btn.disabled = false; btn.textContent = '测试视觉连接';
}
function $(id){ return document.getElementById(id); }
function toast(msg){
  const t = document.createElement('div');
  t.className='toast'; t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),2200);
}
let sidebarOpen=false;
function toggleSidebar(){ sidebarOpen=!sidebarOpen; $('sidebar').classList.toggle('show',sidebarOpen); $('overlay').classList.toggle('show',sidebarOpen); }
function closeSidebar(){ sidebarOpen=false; $('sidebar').classList.remove('show'); $('overlay').classList.remove('show'); }
function onAddFocus(){ $('saddBtns').classList.add('show'); }
function cancelAdd(){ $('sidebarAddInput').value=''; $('saddBtns').classList.remove('show'); }
function addSidebar(){
  const v=$('sidebarAddInput').value.trim();
  if (v && !DATA.sidebars.includes(v)) { DATA.sidebars.push(v); saveData(); renderSidebar(); }
  $('sidebarAddInput').value=''; $('saddBtns').classList.remove('show');
}
function removeSidebar(idx, ev){
  ev.stopPropagation();
  if (DATA.sidebars.length<=1) return toast('至少保留一个板块');
  const name=DATA.sidebars[idx];
  if (activeModule===name) activeModule=DATA.sidebars[0];
  DATA.sidebars.splice(idx,1);
  saveData(); renderSidebar(); loadModule(activeModule);
}
function renderSidebar(){
  const sl=$('sidebarList');
  sl.innerHTML = DATA.sidebars.map((n,i)=>{
    return '<div class="sitem'+(n===activeModule?' active':'')+'" onclick="selectModule(\''+esc(n).replace(/'/g,"\\'")+'\')"><span class="dot"></span><span>'+esc(n)+'</span>'+(DATA.sidebars.length>1?'<span class="del" onclick="removeSidebar('+i+',event)">×</span>':'')+'</div>';
  }).join('');
}
function selectModule(name){ activeModule=name; renderSidebar(); loadModule(name); closeSidebar(); }

function openModal(html){ $('modalBox').innerHTML=html; $('modalWrap').classList.add('show'); }
function closeModal(){ $('modalWrap').classList.remove('show'); }

function loadModule(name){
  activeModule=name;
  $('pageTitle').textContent=name;
  renderSidebar();
  // 角色切换器：仅健身模块显示
  const ps=$('personaSwitcher');
  if (name==='W&C 健身减脂') {
    if (!['today','trend','mine','plan','fitai','record'].includes(activeTab)) activeTab='today';
    ps.style.display='flex';
    updatePersonaPill();
    renderFitnessNav(); renderFitnessContent();
    showFAB();
  } else if (name==='英语学习') {
    if (!['learn','ai','anki','history'].includes(activeTab)) activeTab='learn';
    ps.style.display='none';
    hideFAB();
    hideBottomActions();
    renderEnglishNav(); renderEnglishContent();
  } else {
    $('nav').innerHTML='';
    ps.style.display='none';
    hideFAB();
    hideBottomActions();
    $('content').innerHTML='<div class="empty" style="padding:60px 20px">此板块暂无内容，可在侧边栏删除</div>';
  }
  $('content').scrollTop=0;
}
// 角色切换
function switchPerson(){
  activePerson = activePerson==='W' ? 'C' : 'W';
  localStorage.setItem('wc_activePerson', activePerson);
  updatePersonaPill();
  if (activeModule==='W&C 健身减脂') renderFitnessContent();
  toast('已切换为 '+(activePerson==='W'?getS('wDisplay','W'):getS('cDisplay','C'))+' 模式');
}
function updatePersonaPill(){
  const ps=$('personaSwitcher');
  const name=activePerson==='W'?getS('wDisplay','W'):getS('cDisplay','C');
  const other=activePerson==='W'?getS('cDisplay','C'):getS('wDisplay','W');
  ps.className='persona-pill '+(activePerson==='W'?'pp-w':'pp-c');
  ps.innerHTML='<span class="pp-dot"></span><span>'+name+'</span><span class="pp-switch">切'+other+'</span>';
}
// 浮动 + 按钮
function showFAB(){
  let fab=$('fabBtn');
  if(!fab){
    fab=document.createElement('div');
    fab.id='fabBtn';
    fab.className='fab';
    fab.innerHTML='<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    fab.onclick=()=>openModal('<div class="modal-title">快速记一笔 · '+(activePerson==='W'?getS('wDisplay','W'):getS('cDisplay','C'))+'</div>'
      +'<div class="entry-row" style="margin-top:8px">'
      +'<div class="entry-btn" onclick="closeModal();showPhotoActionSheet()"><div class="e-ic"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></div><div class="e-t">拍照/相册</div><div class="e-s">AI 识别</div></div>'
      +'<div class="entry-btn" onclick="closeModal();startVoice()"><div class="e-ic"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v3a7 7 0 0 0 14 0v-3"/><line x1="12" y1="19" x2="12" y2="22"/></svg></div><div class="e-t">说一句</div><div class="e-s">语音记录</div></div>'
      +'</div>'
      +'<div class="set-row" style="margin-top:16px"><button class="btn-outline" style="width:100%" onclick="closeModal();openAddRecord(\''+activePerson+'\')">手动输入</button></div>'
      +'<div class="modal-btns"><button class="mb-cancel" onclick="closeModal()">取消</button></div>');
    document.body.appendChild(fab);
  }
  fab.style.display='flex';
}
function hideFAB(){ const fab=$('fabBtn'); if(fab) fab.style.display='none'; }

// ========================================
// FITNESS MODULE
// ========================================
const FIT_TABS = [
  {k:'today',label:'今天',icon:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'},
  {k:'trend',label:'趋势',icon:'<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'},
  {k:'mine',label:'我的',icon:'<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'}
];
function renderFitnessNav(){
  $('nav').innerHTML = FIT_TABS.map(t=>'<div class="nav-item'+(activeTab===t.k?' active':'')+'" onclick="switchFitnessTab(\''+t.k+'\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'+t.icon+'</svg><span>'+t.label+'</span></div>').join('');
}
function switchFitnessTab(tab){ activeTab=tab; renderFitnessNav(); renderFitnessContent(); }
function renderFitnessContent(){
  const c=$('content');
  const isSub=!FIT_TABS.some(t=>t.k===activeTab);
  const subBack=isSub?'<div class="sub-back" onclick="switchFitnessTab(\'mine\')"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="15 18 9 12 15 6"/></svg> 返回</div>':'';
  if (activeTab==='today') { c.innerHTML=renderCheckinPage(); hideBottomActions(); showFAB(); }
  else if (activeTab==='trend') { c.innerHTML=renderDataPage(); setTimeout(drawWeightChart,50); hideBottomActions(); showFAB(); }
  else if (activeTab==='mine') { c.innerHTML=renderMinePage(); hideBottomActions(); showFAB(); }
  else if (activeTab==='plan') { c.innerHTML=subBack+renderPlanPage(); hideBottomActions(); hideFAB(); }
  else if (activeTab==='fitai') { c.innerHTML=subBack+renderFitAI(); hideBottomActions(); hideFAB(); }
  else if (activeTab==='record') { c.innerHTML=subBack+renderRecordPage(); showBottomActions(); hideFAB(); }
  else if (activeTab==='briefing') { c.innerHTML=subBack+renderBriefingPage(); hideBottomActions(); hideFAB(); }
}
function renderBriefingPage(){
  const list=window.BRIEFINGS||[];
  if(!list.length){
    return '<div class="empty">暂无鲸闻。今天没有值得说的，就是最好的消息。</div>';
  }
  let html='';
  list.slice().reverse().forEach(b=>{
    html+='<div class="brief-date">'+esc(b.date)+' · '+esc(b.period||'晚报')+'</div>';
    const h=b.headline||{};
    if(h.title){
      html+='<div class="brief-card">'
        +'<div class="brief-headline-title">'+(h.tag?h.tag+' ':'')+esc(h.title)+'</div>'
        +(h.body?'<div class="brief-body">'+esc(h.body)+'</div>':'')
        +(h.impact?'<div class="brief-row"><span class="br-label">→ 关你事</span>'+esc(h.impact)+'</div>':'')
        +(h.action?'<div class="brief-row"><span class="br-label">→ 要动手吗</span>'+esc(h.action)+'</div>':'')
        +'</div>';
    }
    if(b.news&&b.news.length){
      html+='<div class="brief-card brief-news">';
      b.news.forEach(n=>{
        html+='<div class="bn-item"><div class="bn-title">'+(n.tag?n.tag+' ':'')+esc(n.title||'')+'</div><div class="bn-impact">→ '+esc(n.impact||'')+'</div></div>';
      });
      html+='</div>';
    }
    if(b.actions&&b.actions.length){
      html+='<div class="brief-card"><div class="card-head"><span>今日行动清单</span></div>';
      b.actions.forEach(a=>{ html+='<div class="ba-row"><span class="ba-check"></span>'+esc(a)+'</div>'; });
      html+='</div>';
    }
  });
  return html;
}
function renderMinePage(){
  const wd=getS('wDisplay','W'), cd=getS('cDisplay','C');
  const wLatest=[...DATA.weightLog].reverse().find(w=>w.person==='W');
  const cLatest=[...DATA.weightLog].reverse().find(w=>w.person==='C');
  const item=(icon,title,sub,fn)=>'<div class="mine-item" onclick="'+fn+'"><div class="mi-ic">'+icon+'</div><div class="mi-body"><div class="mi-t">'+title+'</div><div class="mi-s">'+sub+'</div></div><div class="mi-arrow"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></div></div>';
  const icPlan='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  const icNews='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><line x1="6" y1="9" x2="18" y2="9"/><line x1="6" y1="13" x2="14" y2="13"/></svg>';
  const icAI='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>';
  const icTrend='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>';
  const icSet='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';
  const icEng='<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>';
  const myName=activePerson==='W'?wd:cd;
  const myLatest=activePerson==='W'?wLatest:cLatest;
  const tw2=getS('targetWeight',{W:58,C:72});
  const myGoal=activePerson==='W'?tw2.W:tw2.C;
  let html='<div class="mine-head"><div class="mine-avatar">'+activePerson+'</div><div style="flex:1"><div class="mine-name">'+esc(myName)+'</div><div class="mine-sub">'+(activePerson==='W'?'和 '+esc(cd)+' 一起减脂中':'和 '+esc(wd)+' 一起减脂中')+'</div></div><span class="mine-goal">目标 '+myGoal+' kg</span></div>';
  html+='<div class="section-title">功能</div>';
  html+=item(icPlan,'我的计划','15 天任务清单','switchFitnessTab(\'plan\')');
  html+=item(icNews,'鲸闻','每日天下事 · 关你什么事','switchFitnessTab(\'briefing\')');
  html+=item(icAI,'AI 减脂顾问','分析饮食 · 推荐餐单','switchFitnessTab(\'fitai\')');
  html+='<div class="section-title">数据</div>';
  html+=item(icTrend,'体重与趋势','最新 '+(myLatest?myLatest.weight+' kg':'暂无记录'),'switchFitnessTab(\'trend\')');
  html+='<div class="section-title">通用</div>';
  html+=item(icSet,'设置','API 与目标体重','openSettings()');
  html+=item(icEng,'英语学习','商务外贸英语','loadModule(\'英语学习\')');
  return html;
}

function personStats(person, dateStr){
  const recs=DATA.fitness.filter(r=>r.date===dateStr&&r.person===person);
  const calIn=recs.filter(r=>r.type==='摄入').reduce((s,r)=>s+(r.calories||0),0);
  const calOut=recs.filter(r=>r.type==='消耗').reduce((s,r)=>s+(r.calories||0),0);
  const protein=recs.filter(r=>r.type==='摄入').reduce((s,r)=>s+(r.protein||0),0);
  const fat=recs.filter(r=>r.type==='摄入').reduce((s,r)=>s+(r.fat||0),0);
  const carbs=recs.filter(r=>r.type==='摄入').reduce((s,r)=>s+(r.carbs||0),0);
  const fiber=recs.filter(r=>r.type==='摄入').reduce((s,r)=>s+(r.fiber||0),0);
  return {recs,calIn,calOut,protein,fat,carbs,fiber};
}

function renderRecordPage(){
  const td=today();
  const pName=activePerson==='W'?getS('wDisplay','W'):getS('cDisplay','C');
  let html='<div class="section-title">'+esc(pName)+' 的今日记录 · '+td+'</div>';
  // 漏记提醒横幅（只提醒当前角色）
  const reminder=checkReminder(td);
  if(reminder) html+='<div class="reminder-banner">'+reminder+'<button onclick="renderFitnessContent()">知道了</button></div>';
  // 待确认卡片（只显示当前角色的）
  const myPending=DATA.pendingFitness.filter(p=>p.person===activePerson);
  if(myPending.length){
    html+='<div class="section-title">待确认 · AI 识别结果</div>';
    myPending.forEach(p=>{
      const cls=p.person==='W'?'pc-w':'pc-c';
      html+='<div class="pending-card '+cls+'">'
        +'<div class="p-basis">🤖 '+esc(p.basis||'AI 识别')+'</div>'
        +'<div class="p-main"><div class="p-content">'+esc(p.content||'')+'</div>'
        +'<div class="p-cal">约 '+p.calories+' kcal</div></div>'
        +'<div class="p-actions">'
        +'<button class="pb-ok" onclick="confirmPending(\''+p.id+'\')">确认记入</button>'
        +'<button class="pb-edit" onclick="editPending(\''+p.id+'\')">修改</button>'
        +'<button class="pb-del" onclick="discardPending(\''+p.id+'\')">放弃</button>'
        +'</div></div>';
    });
  }
  // 只渲染当前角色的卡片
  html+=renderPersonCard(activePerson,pName,td);
  // 晚间总结
  html+=renderEveningSummary(td);
  return html;
}

// ---- 漏记提醒：学习历史记录习惯（平时某时段记、今天没记则温和提醒）----
function checkReminder(td){
  const log=DATA.fitRemindLog||{};
  if(log[td]) return null;
  const nowH=new Date().getHours();
  const wHave=DATA.fitness.some(r=>r.date===td&&r.person==='W');
  const cHave=DATA.fitness.some(r=>r.date===td&&r.person==='C');
  // 历史：W/C 平时最早"摄入"记录的常见小时
  const learnPersonHour=(p)=>{
    const hrs=DATA.fitness.filter(r=>r.person===p&&r.type==='摄入').map(r=>+r.time.split(':')[0]);
    if(!hrs.length) return 13;
    hrs.sort((a,b)=>a-b);
    return hrs[Math.floor(hrs.length/2)]; // 中位数
  };
  let msg='';
  const pName=activePerson==='W'?getS('wDisplay','W'):getS('cDisplay','C');
  const pHave=DATA.fitness.some(r=>r.date===td&&r.person===activePerson);
  if(!pHave && nowH>=learnPersonHour(activePerson)) msg=pName+' 今天还没记录哦，午饭/加餐记得拍一张～';
  if(msg){ DATA.fitRemindLog=DATA.fitRemindLog||{}; DATA.fitRemindLog[td]=true; saveData(); return msg.trim(); }
  return null;
}

// ---- 晚间总结 ----
function renderEveningSummary(td){
  if(!isEvening()) return '';
  const sum=DATA.fitSummary||{};
  if(sum.date===td && sum.text){
    return '<div class="summary-card"><div class="s-title">今日总结</div><div class="s-text">'+esc(sum.text)+'</div><button class="btn-outline btn-sm" onclick="regenerateSummary()">重新生成</button></div>';
  }
  return '<div class="summary-card"><div class="s-title">今日总结</div><div class="s-text" style="color:var(--tx3)">点击生成今日双人减脂小结（AI 或本地模板）</div><button class="btn-outline btn-sm" onclick="generateSummary()">生成总结</button></div>';
}
function isEvening(){ return new Date().getHours()>=20; }
async function generateSummary(){
  const td=today();
  const w=personStats('W',td), c=personStats('C',td);
  const wls=[...DATA.weightLog].reverse().find(x=>x.person==='W');
  const cls=[...DATA.weightLog].reverse().find(x=>x.person==='C');
  const doneTasks=DATA.planTasks.filter(t=>t.date===td&&t.done).length;
  const totalTasks=DATA.planTasks.filter(t=>t.date===td).length;
  const localTpl=(name,st,last,p)=>{
    let s=name+' 今日净摄入 '+(st.calIn-st.calOut)+' kcal'+(last?('，最新体重 '+last.weight+' kg'):'')+'。';
    if(st.protein||st.fat||st.carbs) s+=' 蛋白质'+st.protein+'g 脂肪'+st.fat+'g 碳水'+st.carbs+'g。';
    return s;
  };
  const local='【今日简报】\n'+localTpl(getS('wDisplay','W'),w,wls)+'\n'+localTpl(getS('cDisplay','C'),c,cls)
    +'\n计划完成 '+doneTasks+'/'+totalTasks+(doneTasks>=totalTasks&&totalTasks?'，全部完成，太棒了！👏':(doneTasks>0?'，继续保持～':'，今天还有计划没完成哦'))+'\n明天继续一起加油！💪';
  const key=getS('apiKey','');
  if(!key){
    DATA.fitSummary={date:td,text:local}; saveData(); renderFitnessContent(); return;
  }
  // AI 生成
  DATA.fitSummary={date:td,text:'生成中…'}; renderFitnessContent();
  const sys='你是双人减脂小助手，请用温暖鼓励的语气，根据今日数据生成一段简短的晚间总结（4-6句），点出两人热量/宏量营养素亮点（蛋白质/脂肪/碳水/纤维是否达标）+一句明日建议。回答用中文。';
  const user='今天数据：'+buildFitDataSummary()+'\n今日计划完成 '+doneTasks+'/'+totalTasks+'。';
  const res=await callAI([{role:'system',content:sys},{role:'user',content:user}]);
  DATA.fitSummary={date:td,text:res.error?local:(res.content||local)};
  saveData(); renderFitnessContent();
}
function regenerateSummary(){ DATA.fitSummary={}; generateSummary(); }

// ---- 待确认管理 ----
function confirmPending(id){
  const p=DATA.pendingFitness.find(x=>x.id===id);
  if(!p) return;
  DATA.fitness.push({id:uid(),date:today(),time:now(),person:p.person,type:p.type,content:p.content,calories:p.calories,protein:p.protein||0,fat:p.fat||0,carbs:p.carbs||0,fiber:p.fiber||0,source:p.source,confirmed:true});
  DATA.pendingFitness=DATA.pendingFitness.filter(x=>x.id!==id);
  saveData(); renderFitnessContent(); toast('已记入');
}
function editPending(id){
  const p=DATA.pendingFitness.find(x=>x.id===id);
  if(!p) return;
  openModal('<div class="modal-title">修改识别结果</div>'
    +'<div class="set-row"><label>内容</label><input id="epContent" value="'+esc(p.content)+'"></div>'
    +'<div class="set-row"><label>热量 (kcal)</label><input id="epCal" type="number" value="'+p.calories+'"></div>'
    +'<div class="modal-btns"><button class="mb-cancel" onclick="closeModal()">取消</button><button class="mb-ok" onclick="saveEditPending(\''+id+'\')">保存</button></div>');
}
function saveEditPending(id){
  const p=DATA.pendingFitness.find(x=>x.id===id);
  if(p){ p.content=$('epContent').value.trim()||p.content; p.calories=parseInt($('epCal').value)||p.calories; saveData(); }
  closeModal(); renderFitnessContent();
}
function discardPending(id){ DATA.pendingFitness=DATA.pendingFitness.filter(x=>x.id!==id); saveData(); renderFitnessContent(); }

// ---- 拍照：从相机或相册选图，AI 视觉识别食物热量 ----
function showPhotoActionSheet(){
  const camSvg='<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
  const albSvg='<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>';
  openModal('<div class="modal-title">添加记录</div>'
    +'<div class="entry-row" style="margin-top:8px">'
    +'<div class="entry-btn" onclick="closeModal();choosePhotoFromCamera()"><div class="e-ic">'+camSvg+'</div><div class="e-t">拍照</div><div class="e-s">打开相机</div></div>'
    +'<div class="entry-btn" onclick="closeModal();choosePhotoFromAlbum()"><div class="e-ic">'+albSvg+'</div><div class="e-t">从相册选</div><div class="e-s">挑一张已有的</div></div>'
    +'</div>'
    +'<div class="set-hint" style="margin-top:14px">图片会在本地压缩后发送给视觉 API，不会上传原图</div>'
    +'<div class="modal-btns"><button class="mb-cancel" onclick="closeModal()">取消</button></div>');
}
function choosePhotoFromCamera(){
  const inp=document.createElement('input');
  inp.type='file'; inp.accept='image/*'; inp.capture='environment';
  inp.onchange=()=>{ const f=inp.files[0]; if(f) processPhotoFile(f); };
  inp.click();
}
function choosePhotoFromAlbum(){
  const inp=document.createElement('input');
  inp.type='file'; inp.accept='image/*';
  inp.onchange=()=>{ const f=inp.files[0]; if(f) processPhotoFile(f); };
  inp.click();
}
function processPhotoFile(f){
  const r=new FileReader();
  r.onload=()=>analyzeFoodImage(r.result);
  r.readAsDataURL(f);
}
// 压缩图片到指定最大边长，避免原图过大（>1MB）导致 API 失败或慢
async function compressImage(dataUrl, maxSide=1280, quality=0.85){
  return new Promise((resolve)=>{
    const img=new Image();
    img.onload=()=>{
      let w=img.width, h=img.height;
      if(Math.max(w,h)>maxSide){
        if(w>h){ h=Math.round(h*maxSide/w); w=maxSide; }
        else { w=Math.round(w*maxSide/h); h=maxSide; }
      }
      const c=document.createElement('canvas'); c.width=w; c.height=h;
      const ctx=c.getContext('2d'); ctx.drawImage(img,0,0,w,h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror=()=>resolve(dataUrl); // 压缩失败就传原图
    img.src=dataUrl;
  });
}
// 全屏进度遮罩
function showAIProgress(text, sub){
  let el=$('aiOverlay');
  if(!el){
    el=document.createElement('div'); el.id='aiOverlay'; el.className='ai-overlay';
    el.innerHTML='<div class="ai-card"><div class="ai-spinner"></div><div class="ai-progress-text" id="aiProgText">处理中…</div><div class="ai-progress-steps" id="aiProgSteps"></div></div>';
    document.body.appendChild(el);
  }
  $('aiProgText').textContent=text||'处理中…';
  $('aiProgSteps').innerHTML=sub||'';
  el.classList.add('show');
}
function setAIProgress(text, sub){ $('aiProgText').textContent=text; $('aiProgSteps').innerHTML=sub||''; }
function hideAIProgress(){ const el=$('aiOverlay'); if(el) el.classList.remove('show'); }

async function analyzeFoodImage(b64){
  showAIProgress('准备图片…','压缩并校验');
  try{
    const compressed=await compressImage(b64);
    setAIProgress('AI 识别中…','已发送给视觉模型（通常 3-10 秒）');
    const res=await callAIVision(compressed,'请识别这张食物照片中的餐食内容，估算总热量（kcal）以及蛋白质(g)、脂肪(g)、碳水(g)、膳食纤维(g)。只返回一个 JSON：{"content":"菜名简述","calories":数字,"protein":蛋白质克数,"fat":脂肪克数,"carbs":碳水克数,"fiber":膳食纤维克数,"type":"摄入","basis":"识别依据一句话"}');
    hideAIProgress();
    let obj;
    try{ obj=JSON.parse((res.content||'').replace(/```json|```/g,'').trim()); }catch(e){ obj=null; }
    if(!obj || res.error){
      let msg = res.error||'识别失败，可手动添加';
      if (res.error && (res.error.indexOf('image')>=0 || res.error.indexOf('vision')>=0 || res.error.indexOf('400')>=0)) {
        msg = '当前视觉模型不接受这张图。请到设置换 qwen3.7-plus / qwen3-vl-plus / qwen-vl-max-latest 等模型，并确认视觉 API Key 正确';
      } else if (res.error && res.error.indexOf('401')>=0) {
        msg = '视觉 API Key 无效或没填，请到设置填写';
      } else if (res.error && res.error.indexOf('404')>=0) {
        msg = '视觉模型名不存在。请到设置换下拉里的另一个模型（首字母小写）';
      } else if (res.error && (res.error.indexOf('Failed to fetch')>=0 || res.error.indexOf('CORS')>=0)) {
        msg = '网络/CORS 失败，请检查网络或换一个视觉模型供应商';
      }
      return toast(msg);
    }
    DATA.pendingFitness.push({id:uid(),person:activePerson,type:obj.type==='消耗'?'消耗':'摄入',content:obj.content,calories:Math.max(1,Math.round(obj.calories)),protein:Math.max(0,Math.round(obj.protein||0)),fat:Math.max(0,Math.round(obj.fat||0)),carbs:Math.max(0,Math.round(obj.carbs||0)),fiber:Math.max(0,Math.round(obj.fiber||0)),basis:obj.basis||'AI 视觉识别',source:'拍照',createdAt:now()});
    saveData(); renderFitnessContent(); toast('已生成待确认');
  }catch(e){
    hideAIProgress();
    toast('图片处理失败：'+e.message);
  }
}
// ---- 语音：长按录制，松开识别 ----
let voiceRec=null, voiceTimer=null, voiceStartT=0, voiceLastText='', voiceProcessed=false;
function startVoiceHold(e){
  if(e && e.preventDefault) e.preventDefault();
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){
    const txt=prompt('语音识别不可用，请直接输入描述（如：午餐吃了鸡胸肉沙拉，约400千卡）：');
    if(txt) parseVoiceText(txt);
    return;
  }
  // 停止上一次可能未清理的识别
  if(voiceRec){ try{ voiceRec.abort(); }catch(e){} }
  voiceLastText=''; voiceProcessed=false;
  const btn=document.querySelector('.ba-voice');
  if(btn) btn.classList.add('recording');
  showVoiceIndicator();
  voiceRec=new SR(); voiceRec.lang='zh-CN'; voiceRec.interimResults=true; voiceRec.maxAlternatives=1; voiceRec.continuous=false;
  voiceStartT=Date.now();
  voiceRec.onresult=(ev)=>{
    const txt=ev.results[0][0].transcript;
    if(txt) voiceLastText=txt;
    if(ev.results[0].isFinal && !voiceProcessed){
      voiceProcessed=true;
      parseVoiceText(txt);
    }
  };
  voiceRec.onerror=(ev)=>{
    if(!voiceProcessed && voiceLastText){
      voiceProcessed=true;
      parseVoiceText(voiceLastText);
    } else if(!voiceProcessed){
      toast('未识别到语音，请重试');
    }
    cleanupVoice();
  };
  voiceRec.onend=()=>{ cleanupVoice(); };
  try{ voiceRec.start(); }catch(err){ cleanupVoice(); toast('无法启动语音'); }
  voiceTimer=setInterval(updateVoiceIndicator,100);
}
function stopVoiceHold(){
  if(voiceRec && !voiceProcessed){
    if(voiceLastText){
      voiceProcessed=true;
      parseVoiceText(voiceLastText);
    }
    try{ voiceRec.abort(); }catch(e){}
  }
  cleanupVoice();
}
function cleanupVoice(){
  voiceRec=null;
  voiceLastText='';
  if(voiceTimer){ clearInterval(voiceTimer); voiceTimer=null; }
  const btn=document.querySelector('.ba-voice');
  if(btn) btn.classList.remove('recording');
  hideVoiceIndicator();
}
// 保留 startVoice 给 FAB 弹窗用（点击式）
function startVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){
    const txt=prompt('语音识别不可用，请直接输入描述（如：午餐吃了鸡胸肉沙拉，约400千卡）：');
    if(txt) parseVoiceText(txt);
    return;
  }
  let lt='', done=false;
  const rec=new SR(); rec.lang='zh-CN'; rec.interimResults=true; rec.maxAlternatives=1;
  toast('请说话…说完自动识别');
  rec.onresult=(ev)=>{
    const txt=ev.results[0][0].transcript;
    if(txt) lt=txt;
    if(ev.results[0].isFinal && !done){ done=true; parseVoiceText(txt); }
  };
  rec.onerror=()=>{
    if(!done && lt){ done=true; parseVoiceText(lt); }
    else if(!done) toast('未识别到语音，可手动输入');
  };
  try{ rec.start(); }catch(e){ toast('无法启动语音'); }
}
// 录音指示器
function showVoiceIndicator(){
  let el=$('voiceIndicator');
  if(!el){
    el=document.createElement('div'); el.id='voiceIndicator'; el.className='voice-indicator';
    el.innerHTML='<div class="vi-dot"></div><div class="vi-text">正在录音… 松开发送</div><div class="vi-time" id="viTime">0:00</div>';
    document.body.appendChild(el);
  }
  el.classList.add('show');
}
function updateVoiceIndicator(){
  const s=Math.floor((Date.now()-voiceStartT)/1000);
  const mm=Math.floor(s/60), ss=s%60;
  const el=$('viTime');
  if(el) el.textContent=mm+':'+(ss<10?'0':'')+ss;
}
function hideVoiceIndicator(){ const el=$('voiceIndicator'); if(el) el.classList.remove('show'); }

// 底部主操作栏（拍照 + 长按录音）
function showBottomActions(){
  let el=$('bottomActions');
  if(!el){
    el=document.createElement('div'); el.id='bottomActions'; el.className='bottom-actions';
    el.innerHTML='<div class="ba-wrap">'
      +'<button class="ba-btn ba-photo" onclick="showPhotoActionSheet()" aria-label="拍照">'
      +'<span class="ba-circle"><span class="ba-ic"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="40" height="40" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M26 22a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V11a2 2 0 0 1 2-2h4l2-3h4l2 3h4a2 2 0 0 1 2 2v11Z"/><circle cx="16" cy="16.5" r="4"/></svg></span></span><span class="ba-t">拍照</span></button>'
      +'<button class="ba-btn ba-voice" aria-label="按住说话 录音" '
      +'ontouchstart="startVoiceHold(event)" ontouchend="stopVoiceHold()" ontouchcancel="stopVoiceHold()" '
      +'onmousedown="startVoiceHold(event)" onmouseup="stopVoiceHold()" onmouseleave="stopVoiceHold()">'
      +'<span class="ba-circle"><span class="ba-ic"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="40" height="40" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="12" y="1" width="8" height="13" rx="4"/><path d="M7 13v3a9 9 0 0 0 18 0v-3"/><line x1="16" y1="21" x2="16" y2="27"/><line x1="10" y1="27" x2="22" y2="27"/></svg></span></span><span class="ba-t">按住说话</span></button>'
      +'</div>';
    document.body.appendChild(el);
  }
  el.style.display='flex';
  // 给内容区加底部留白
  $('content').style.paddingBottom='220px';
}
function hideBottomActions(){ const el=$('bottomActions'); if(el) el.style.display='none'; $('content').style.paddingBottom='100px'; }
async function parseVoiceText(txt){
  if(!txt || !txt.trim()) { toast('未识别到有效内容，请重试'); return; }
  const key=getS('apiKey','');
  if(!key){ // 本地兜底：粗略解析"X千卡"
    const m=txt.match(/(\d+)\s*千?卡/);
    DATA.pendingFitness.push({id:uid(),person:activePerson,type:'摄入',content:txt,calories:m?parseInt(m[1]):0,basis:'语音输入（无AI解析）',source:'语音',createdAt:now()});
    saveData(); renderFitnessContent(); return;
  }
  toast('AI 解析中…');
  try {
    const res=await callAI([{role:'system',content:'你帮用户把一句口语饮食记录解析成 JSON：{"content":"餐食简述","calories":估算总热量数字,"protein":蛋白质克数,"fat":脂肪克数,"carbs":碳水克数,"fiber":膳食纤维克数,"type":"摄入"或"消耗","basis":"一句识别依据"}。估算要合理，只返回JSON。'},{role:'user',content:txt}]);
    let obj; try{ obj=JSON.parse((res.content||'').replace(/```json|```/g,'').trim()); }catch(e){ obj=null; }
    if(!obj){ DATA.pendingFitness.push({id:uid(),person:activePerson,type:'摄入',content:txt,calories:0,protein:0,fat:0,carbs:0,fiber:0,basis:'语音输入',source:'语音',createdAt:now()}); }
    else DATA.pendingFitness.push({id:uid(),person:activePerson,type:obj.type==='消耗'?'消耗':'摄入',content:obj.content,calories:Math.max(0,Math.round(obj.calories)),protein:Math.max(0,Math.round(obj.protein||0)),fat:Math.max(0,Math.round(obj.fat||0)),carbs:Math.max(0,Math.round(obj.carbs||0)),fiber:Math.max(0,Math.round(obj.fiber||0)),basis:obj.basis||'语音+AI解析',source:'语音',createdAt:now()});
    saveData(); renderFitnessContent(); toast('已生成待确认');
  } catch(e) {
    // AI 调用失败，直接用原文记录
    DATA.pendingFitness.push({id:uid(),person:activePerson,type:'摄入',content:txt,calories:0,protein:0,fat:0,carbs:0,fiber:0,basis:'语音输入（AI不可用）',source:'语音',createdAt:now()});
    saveData(); renderFitnessContent(); toast('AI 暂时不可用，已记录原文');
  }
}
// ---- 视觉 API ----
async function callAIVision(b64, prompt){
  const key=getS('visionKey', getS('apiKey','')); const endpoint=getS('visionEndpoint','https://dashscope.aliyuncs.com/compatible-mode/v1'); const model=getS('visionModel','qwen-vl-max-latest');
  if(!key) return {error:'请先在设置中配置「视觉模型」的 API Key（拍照识别专用）'};
  try{
    const resp=await fetch(endpoint+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify({model,messages:[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:b64}}]}]})});
    if(!resp.ok){ const e=await resp.text(); return {error:'API 错误 ('+resp.status+'): '+e.slice(0,200)}; }
    const j=await resp.json();
    return {content:(j.choices&&j.choices[0]&&j.choices[0].message&&j.choices[0].message.content)||'',ok:true};
  }catch(e){ return {error:'网络错误: '+e.message}; }
}
function renderPersonCard(person,name,td){
  const {recs,calIn,calOut}=personStats(person,td);
  const cls=person==='W'?'pc-w':'pc-c';
  const recent=recs.slice(-3).reverse();
  return '<div class="person-card '+cls+'">'
    +'<div class="pc-head"><span class="pc-name">'+esc(name)+'</span><span class="pc-kcal">净摄入 '+(calIn-calOut)+' kcal</span></div>'
    +'<div class="pc-kcals">'
    +'<div class="pc-metric"><div class="v">'+calIn+'</div><div class="l">摄入 kcal</div></div>'
    +'<div class="pc-metric"><div class="v">'+calOut+'</div><div class="l">消耗 kcal</div></div>'
    +'</div>'
    +'<div class="pc-btns">'
    +'<button onclick="quickAdd(\''+person+'\',\'摄入\',300)">+摄入300</button>'
    +'<button onclick="quickAdd(\''+person+'\',\'摄入\',500)">+摄入500</button>'
    +'<button onclick="quickAdd(\''+person+'\',\'消耗\',200)">+消耗200</button>'
    +'<button onclick="openWeightModal(\''+person+'\')">记体重</button>'
    +'</div>'
    +'<div class="pc-recs">'+(recent.length?recent.map(r=>'<div class="r"><span>'+r.time+' '+esc(r.content||r.type)+'</span><span>'+(r.calories?r.calories+' kcal':'')+'</span></div>').join(''):'今日暂无记录')+'</div>'
    +'<button class="pc-add" onclick="openAddRecord(\''+person+'\')">+ 添加 '+esc(name)+' 的详细记录</button>'
    +'</div>';
}

function quickAdd(person,type,cal){
  DATA.fitness.push({id:uid(),date:today(),time:now(),person,type,content:type+' '+cal+' kcal',calories:cal,source:'手动',confirmed:true});
  saveData(); renderFitnessContent(); toast('已记录');
}
function openAddRecord(person){
  const name=person==='W'?getS('wDisplay','W'):getS('cDisplay','C');
  const exOpts=Object.keys(MET_TABLE).map(e=>'<option>'+e+'</option>').join('');
  openModal('<div class="modal-title">添加 '+esc(name)+' 的记录</div>'
    +'<div class="set-row"><label>类型</label><select id="mType" onchange="onTypeChange()"><option>摄入</option><option>消耗</option></select></div>'
    +'<div class="set-row"><label>内容</label><input id="mContent" placeholder="例如：午餐鸡胸肉沙拉 / 跑步30分钟"></div>'
    +'<div class="set-row" id="calRow"><label>热量 (kcal)</label><input id="mCal" type="number" placeholder="估算值"></div>'
    +'<div class="set-row" id="exRow" style="display:none"><label>运动项目（按 MET 公式自动估算）</label><select id="mEx">'+exOpts+'</select></div>'
    +'<div class="set-row" id="exDurRow" style="display:none"><label>时长（分钟）</label><input id="mExDur" type="number" value="30" oninput="onExDurChange()"></div>'
    +'<div class="set-hint" id="exHint" style="display:none"></div>'
    +'<div class="modal-btns"><button class="mb-cancel" onclick="closeModal()">取消</button><button class="mb-ok" onclick="saveAddRecord(\''+person+'\')">保存</button></div>');
}
function onTypeChange(){
  const isOut=$('mType').value==='消耗';
  $('exRow').style.display=isOut?'block':'none';
  $('exDurRow').style.display=isOut?'block':'none';
  $('calRow').style.display=isOut?'none':'block';
  if(isOut) onExDurChange();
}
function onExDurChange(){
  const ex=$('mEx').value, min=parseInt($('mExDur').value)||30;
  const e=estExercise('W',ex,min);
  $('exHint').style.display='block';
  $('exHint').textContent='按 MET '+e.met+' × 体重 '+e.kg+'kg × '+(min/60).toFixed(2)+'h ≈ '+e.min+'~'+e.max+' kcal';
}
function saveAddRecord(person){
  const type=$('mType').value, content=$('mContent').value.trim();
  let cal=parseInt($('mCal').value)||0;
  if(type==='消耗' && $('exRow').style.display!=='none'){
    const ex=$('mEx').value, min=parseInt($('mExDur').value)||30;
    const e=estExercise(person,ex,min); cal=Math.round((e.min+e.max)/2);
  }
  if(!content) return toast('请填写内容');
  DATA.fitness.push({id:uid(),date:today(),time:now(),person,type,content,calories:cal,source:'手动',confirmed:true});
  saveData(); closeModal(); renderFitnessContent(); toast('已保存');
}
function openWeightModal(person){
  const name=person==='W'?getS('wDisplay','W'):getS('cDisplay','C');
  const latest=[...DATA.weightLog].reverse().find(w=>w.person===person);
  openModal('<div class="modal-title">记录 '+esc(name)+' 的体重</div>'
    +'<div class="set-row"><label>体重 (kg)</label><input id="mWeight" type="number" step="0.1" placeholder="'+(latest?('上次 '+latest.weight+' kg'):'输入体重')+'"></div>'
    +'<div class="modal-btns"><button class="mb-cancel" onclick="closeModal()">取消</button><button class="mb-ok" onclick="saveWeight(\''+person+'\')">保存</button></div>');
}
function saveWeight(person){
  const w=parseFloat($('mWeight').value);
  if(!w) return toast('请输入体重');
  const td=today();
  const existing=DATA.weightLog.find(x=>x.date===td&&x.person===person);
  if(existing){ existing.weight=w; existing.source=existing.source||'手动'; }
  else DATA.weightLog.push({id:uid(),date:td,person,weight:w,source:'手动',time:now()});
  saveData(); closeModal(); renderFitnessContent(); toast('体重已记录');
}

let chkDate=null;
function setChkDate(d){ chkDate=d; renderFitnessContent(); }
function shiftWeek(n){ chkDate=addDays(chkDate||today(),n*7); renderFitnessContent(); }
function ringSvg(pct,color){
  const r=26,c=2*Math.PI*r,off=Math.max(0,Math.min(100,pct||0));
  return '<svg viewBox="0 0 64 64" width="64" height="64"><circle cx="32" cy="32" r="'+r+'" fill="none" stroke="var(--border-soft)" stroke-width="7"/><circle cx="32" cy="32" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="7" stroke-linecap="round" stroke-dasharray="'+c.toFixed(1)+'" stroke-dashoffset="'+(c*(1-off/100)).toFixed(1)+'" transform="rotate(-90 32 32)"/></svg>';
}
function meCheckin(person,date){
  const recs=DATA.fitness.filter(r=>r.date===date&&r.person===person&&r.type==='摄入');
  const firstIn=(h1,h2)=>{const rs=recs.filter(r=>{const h=+r.time.split(':')[0];return h>=h1&&h<h2;}); return rs.length?rs[0]:null;};
  const meal=(label,icon,h1,h2)=>{const r=firstIn(h1,h2);return {label,icon,time:r?r.time:null,done:!!r};};
  const iconCoffee='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/></svg>';
  const iconUtensils='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/></svg>';
  const iconDome='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 17h16"/><path d="M5 17a7 7 0 0 1 14 0"/><circle cx="12" cy="8" r="1"/></svg>';
  const iconScale='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 5c0 1.5 1.8 2.5 4 2.5s4-1 4-2.5"/><circle cx="12" cy="13" r="3.2"/></svg>';
  const w=DATA.weightLog.find(x=>x.date===date&&x.person===person);
  return [
    meal('早餐',iconCoffee,5,11),
    meal('午餐',iconUtensils,11,16),
    meal('晚餐',iconDome,16,23),
    {label:'体重',icon:iconScale,time:w?(w.weight+' kg'):null,done:!!w}
  ];
}
function chkRingHTML(pct,color,num,unit,label,sub){
  return '<div class="ring-item"><div class="ring-wrap">'+ringSvg(pct,color)+'<div class="ring-num">'+num+'</div><div class="ring-unit">'+unit+'</div></div><div class="ring-label">'+label+'</div><div class="ring-sub">'+sub+'</div></div>';
}
function renderCheckinPage(){
  const td=today();
  if(!chkDate) chkDate=td;
  const wd=getS('wDisplay','W'), cd=getS('cDisplay','C');
  const dayNames=['一','二','三','四','五','六','日'];
  const base=new Date(chkDate+'T00:00:00');
  const dow=base.getDay()||7;
  const monday=addDays(chkDate,-(dow-1));
  // 日期横条（本周）
  let html='<div class="cal-strip"><div class="cal-nav" onclick="shiftWeek(-1)">‹</div><div class="cal-days">';
  for(let i=0;i<7;i++){
    const d=addDays(monday,i);
    const dd=new Date(d+'T00:00:00');
    const hasRec=DATA.fitness.some(r=>r.date===d);
    const isToday=d===td;
    const isSel=d===chkDate;
    const cls='cal-day'+(isToday?' today':(isSel?' sel':''));
    html+='<div class="'+cls+'" onclick="setChkDate(\''+d+'\')">'
      +'<div class="cd-dow">周'+dayNames[(dd.getDay()+6)%7]+'</div>'
      +'<div class="cd-num">'+(isToday?'今':dd.getDate())+'</div>'
      +'<div class="cd-dot'+(hasRec?'':' off')+'"></div>'
      +'</div>';
  }
  html+='</div><div class="cal-nav" onclick="shiftWeek(1)">›</div></div>';
  // 今日进度大卡（分段环 + 图例）
  const st=personStats(activePerson,chkDate);
  const tgt=dailyMacroTargets(activePerson);
  const ci=meCheckin(activePerson,chkDate);
  const doneCount=ci.filter(x=>x.done).length;
  const intakePct=Math.min(1,st.calIn/(tgt.calories||1));
  const burnPct=Math.min(1,st.calOut/500);
  const logPct=doneCount/4;
  const remaining=Math.max(0,tgt.calories-st.calIn+st.calOut);
  const segRing=(ip,bp,lp,size,sw)=>{
    const r=(size-sw)/2, C=2*Math.PI*r;
    const segs=[{p:ip,c:'#DE6B48'},{p:bp,c:'#8A7A5E'},{p:lp,c:'#B8DBD9'}];
    const sum=Math.max(0.0001,segs.reduce((s,x)=>s+Math.max(0,Math.min(1,x.p)),0));
    let ring='<svg viewBox="0 0 '+size+' '+size+'" width="'+size+'" height="'+size+'"><circle cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'" fill="none" stroke="#F3F1EC" stroke-width="'+sw+'"/>';
    let start=0;
    segs.forEach(sg=>{
      const frac=Math.max(0,Math.min(1,sg.p))/sum;
      if(frac<=0.001) return;
      const len=C*frac;
      ring+='<circle cx="'+(size/2)+'" cy="'+(size/2)+'" r="'+r+'" fill="none" stroke="'+sg.c+'" stroke-width="'+sw+'" stroke-linecap="round" stroke-dasharray="'+len.toFixed(1)+' '+(C-len).toFixed(1)+'" transform="rotate('+(-90+start*360).toFixed(1)+' '+(size/2)+' '+(size/2)+')"/>';
      start+=frac;
    });
    ring+='</svg>';
    return ring;
  };
  html+='<div class="ring-card"><div class="checkin-head" style="padding:16px 18px 0"><span>今日进度</span><span style="font-size:12px;color:var(--tx3)">'+now()+' 更新</span></div>'
    +'<div class="big-ring-wrap"><div class="big-ring">'+segRing(intakePct,burnPct,logPct,180,14)+'<div class="big-ring-center"><div class="brc-label">今日剩余</div><div class="brc-num">'+remaining+'</div><div class="brc-unit">kcal</div></div></div></div>'
    +'<div class="ring-legend">'
    +'<div class="rl-item"><span class="rl-dot" style="background:#DE6B48"></span><div class="rl-body"><div class="rl-t">摄入</div><div class="rl-v">'+st.calIn+'/'+tgt.calories+' kcal</div></div></div>'
    +'<div class="rl-item"><span class="rl-dot" style="background:#8A7A5E"></span><div class="rl-body"><div class="rl-t">消耗</div><div class="rl-v">'+st.calOut+' kcal</div></div></div>'
    +'<div class="rl-item"><span class="rl-dot" style="background:#B8DBD9"></span><div class="rl-body"><div class="rl-t">记录</div><div class="rl-v">'+doneCount+'/4 项</div></div></div>'
    +'</div></div>';
  // 今日打卡清单（带时间）
  html+='<div class="checkin-card"><div class="checkin-head"><span>今日打卡</span><span style="font-size:13px;color:var(--p500)">'+doneCount+'/4 已完成</span></div>';
  ci.forEach(item=>{
    html+='<div class="checkin-row"><span class="ci-icon">'+item.icon+'</span><span class="ci-label">'+item.label+'</span><span class="ci-time">'+(item.time||'待打卡')+'</span><span class="ci-check'+(item.done?' done':'')+'"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></span></div>';
  });
  html+='</div>';
  // 情侣双人打卡（进度条）
  html+='<div class="couple-card"><div class="checkin-head"><span>情侣双人打卡</span></div><div class="couple-grid">';
  ['W','C'].forEach(p=>{
    const nm=p==='W'?wd:cd;
    const cci=meCheckin(p,chkDate);
    const cdone=cci.filter(x=>x.done).length;
    const pst=personStats(p,chkDate);
    const ptgt=dailyMacroTargets(p);
    const pct=Math.round(cdone/4*100);
    html+='<div class="couple-item '+p.toLowerCase()+'"><div class="couple-top"><span class="couple-name">'+p+'</span><span class="couple-title">'+esc(nm)+'</span></div><div class="couple-done">'+cdone+'/4 已完成</div><div class="couple-intake">摄入 '+pst.calIn+'/'+ptgt.calories+' kcal</div><div class="couple-bar"><div class="couple-fill" style="width:'+pct+'%;background:var(--'+(p==='W'?'p500':'g500')+')"></div></div></div>';
  });
  html+='</div></div>';
  // 当日记录列表（单列时间轴）
  const items=[];
  DATA.fitness.filter(r=>r.date===chkDate).forEach(r=>{
    items.push({time:r.time||'12:00',kind:'food',cls:r.person==='W'?'w':'c',person:r.person,type:r.type,content:r.content,calories:r.calories,source:r.source||'手动',confirmed:r.confirmed!==false});
  });
  DATA.weightLog.filter(w=>w.date===chkDate).forEach(w=>{
    items.push({time:w.time||'08:00',kind:'weight',cls:w.person==='W'?'w':'c',person:w.person,weight:w.weight,source:w.source||'手动',confirmed:true});
  });
  items.sort((a,b)=>b.time.localeCompare(a.time));
  html+='<div class="section-title">当日记录</div>';
  if(!items.length){
    html+='<div class="empty">这天还没有记录</div>';
  }else{
    items.forEach(r=>{
      const nm=r.person==='W'?wd:cd;
      const nameBadge='<span class="badge badge-'+r.cls+'">'+esc(nm)+'</span>';
      const srcBadge=r.source==='拍照'?'📷':(r.source==='语音'?'🎙️':'');
      let main;
      if(r.kind==='weight'){ main='<div class="tt">'+nameBadge+' 体重 '+r.weight+' kg '+srcBadge+'</div><div class="tm">'+r.time+'</div>'; }
      else { const tb=r.type==='消耗'?'<span class="badge badge-c">消耗</span> ':''; main='<div class="tt">'+nameBadge+' '+tb+esc(r.content||'')+' '+srcBadge+'</div><div class="tm">'+r.time+(r.calories?' · '+r.calories+' kcal':'')+'</div>'; }
      html+='<div class="tl-item '+r.cls+'"><div class="bar"></div><div class="body">'+main+'</div></div>';
    });
  }
  // 今日总结卡
  html+='<div class="brief-card" style="margin-top:4px"><div class="card-head"><span>今日总结</span></div>';
  const wstS=personStats('W',chkDate), cstS=personStats('C',chkDate);
  const wtgtS=dailyMacroTargets('W'), ctgtS=dailyMacroTargets('C');
  const sumRow=(p,name,st,tgt)=>{
    const remain=tgt.calories-st.calIn+st.calOut;
    const status=st.calIn===0?'未记录':(remain>=0?'达标':'超标 '+Math.abs(remain)+' kcal');
    const color=st.calIn===0?'var(--tx3)':(remain>=0?'var(--p500)':'#D9534F');
    return '<div class="sum-row"><span class="couple-name" style="background:var(--'+(p==='W'?'p500':'g500')+')">'+p+'</span><span class="sum-nm">'+esc(name)+'</span><span class="sum-status" style="color:'+color+'">'+status+'</span></div>';
  };
  html+=sumRow('W',wd,wstS,wtgtS)+sumRow('C',cd,cstS,ctgtS);
  let sumComment='';
  const wHasS=wstS.calIn>0, cHasS=cstS.calIn>0;
  if(!wHasS&&!cHasS) sumComment='今天还没记录，明天记得拍照打卡～';
  else if(wHasS&&cHasS&&wstS.calIn<=wtgtS.calories&&cstS.calIn<=ctgtS.calories) sumComment='俩人都拿捏住了，保持这个节奏 (¬_¬)';
  else if(wHasS&&cHasS) sumComment='有人今天超了，晚饭是不是又加餐了？互相盯一下～';
  else sumComment='还有一位没记录哦，互相监督一下～';
  html+='<div class="sum-comment">'+sumComment+'</div></div>';
  return html;
}
function renderTimelinePage(){
  const wd=getS('wDisplay','W'), cd=getS('cDisplay','C');
  let html='<div class="section-title">双人时间线 · 互相可见</div>'
    +'<div class="tl-filter"><input type="date" value="'+tlDate+'" onchange="setTlDate(this.value)"><button class="btn-outline btn-sm" onclick="setTlDate(\'\');tlDate=\'\'">全部日期</button></div>';
  // 合并双人记录为单列时间轴，人名 badge + 颜色边条区分
  let items=[];
  ['W','C'].forEach(person=>{
    const name=person==='W'?wd:cd;
    const cls=person==='W'?'w':'c';
    DATA.fitness.filter(r=>r.person===person).forEach(r=>items.push({date:r.date,time:r.time||'12:00',kind:'food',cls,name,type:r.type,content:r.content,calories:r.calories,source:r.source||'手动',confirmed:r.confirmed!==false}));
    DATA.weightLog.filter(w=>w.person===person).forEach(w=>items.push({date:w.date,time:w.time||'08:00',kind:'weight',cls,name,content:'记录体重',weight:w.weight,source:w.source||'手动',confirmed:true}));
  });
  items.sort((a,b)=>(b.date+b.time).localeCompare(a.date+a.time));
  let filtered=items;
  if(tlDate) filtered=filtered.filter(r=>r.date===tlDate);
  if(!filtered.length){
    html+='<div class="empty">暂无记录</div>';
  } else {
    let lastDate='';
    filtered.slice(0,100).forEach(r=>{
      if(r.date!==lastDate){ html+='<div class="tl-date">'+r.date+'</div>'; lastDate=r.date; }
      const srcBadge=r.source==='拍照'?'<span class="badge badge-src">📷</span>':(r.source==='语音'?'<span class="badge badge-src">🎙️</span>':'');
      const confBadge=r.confirmed?'':'<span class="badge badge-warn">待确认</span>';
      const nameBadge='<span class="badge badge-'+r.cls+'" style="margin-right:6px">'+esc(r.name)+'</span>';
      let main;
      if(r.kind==='weight'){
        main='<div class="tt">'+nameBadge+'体重 '+r.weight+' kg '+srcBadge+confBadge+'</div><div class="tm">'+r.time+'</div>';
      } else {
        const typeBadge=r.type==='消耗'?'<span class="badge badge-c">消耗</span> ':'';
        main='<div class="tt">'+nameBadge+typeBadge+esc(r.content||'')+' '+srcBadge+confBadge+'</div>'
          +'<div class="tm">'+r.time+(r.calories?' · '+r.calories+' kcal':'')+'</div>';
      }
      html+='<div class="tl-item '+r.cls+'"><div class="bar"></div><div class="body">'+main+'</div></div>';
    });
  }
  return html;
}
function setTlFilter(f){ tlFilter=f; renderFitnessContent(); }
function setTlDate(d){ tlDate=d; renderFitnessContent(); }

function renderDataPage(){
  const wd=getS('wDisplay','W'), cd=getS('cDisplay','C');
  const td=today();
  const myColor=activePerson==='W'?'var(--p500)':'var(--g500)';
  const wLatest=[...DATA.weightLog].reverse().find(w=>w.person==='W');
  const cLatest=[...DATA.weightLog].reverse().find(w=>w.person==='C');
  const myLatest=activePerson==='W'?wLatest:cLatest;
  const range=7;
  const cutoff=addDays(td,-(range-1));
  // 连续打卡天数（今天没记录不打断，从昨天数）
  let streak=0;
  for(let i=0;i<120;i++){
    const d=addDays(td,-i);
    const has=DATA.fitness.some(r=>r.date===d&&r.person===activePerson);
    if(has) streak++;
    else if(i===0) continue;
    else break;
  }
  // 最近7天打卡圆点
  let dots='';
  for(let i=6;i>=0;i--){
    const d=addDays(td,-i);
    const has=DATA.fitness.some(r=>r.date===d&&r.person===activePerson);
    const dd=new Date(d+'T00:00:00');
    dots+='<div class="streak-dot'+(has?' on':'')+'"><span class="sd-dot"></span><span class="sd-date">'+(dd.getMonth()+1)+'/'+dd.getDate()+'</span></div>';
  }
  // 本周体重变化（当前人）
  const myWeights=DATA.weightLog.filter(w=>w.person===activePerson&&w.date>=cutoff).sort((a,b)=>a.date.localeCompare(b.date));
  const weightChange=myWeights.length>=2?(myWeights[myWeights.length-1].weight-myWeights[0].weight):null;
  // 近7天平均摄入（当前人）
  const recent=DATA.fitness.filter(r=>r.person===activePerson&&r.type==='摄入'&&r.date>=cutoff);
  const daysWith=[...new Set(recent.map(r=>r.date))].length;
  const avgIn=daysWith?Math.round(recent.reduce((s,r)=>s+(r.calories||0),0)/daysWith):0;
  const tgt=dailyMacroTargets(activePerson);
  const avgPct=Math.min(100,Math.round(avgIn/(tgt.calories||1)*100));
  const flameSvg='<svg viewBox="0 0 24 24" width="38" height="38" fill="#DE6B48"><path d="M12 2c.5 2.5-1 4-1.5 5.5-.4 1.2.2 2.5 1.5 2.5s2-1.3 1.6-2.5C13 6 12.5 5 13 3.5c2.5 1.5 4.5 4 4.5 7.5a5.5 5.5 0 1 1-11 0c0-4 3-6.5 5.5-9z"/></svg>';
  let html='<div class="trend-title">趋势</div>';
  html+='<div class="seg trend-seg"><div class="'+(dataTrendRange===7?'on':'')+'" onclick="setTrendRange(7)">近7天</div><div class="'+(dataTrendRange===30?'on':'')+'" onclick="setTrendRange(30)">近30天</div></div>';
  // 体重曲线卡
  html+='<div class="card" style="margin:0 16px 14px;padding:18px">'
    +'<div class="card-head"><span>体重曲线</span><span class="card-meta">'+(weightChange===null?'近 7 天':('本周 '+(weightChange>0?'+':'')+weightChange.toFixed(1)+' kg'))+'</span></div>'
    +'<canvas id="weightChart" style="width:100%;height:200px"></canvas>'
    +'<div class="chart-legend"><span class="lg"><span class="lg-dot" style="background:var(--p500)"></span>'+esc(wd)+'</span><span class="lg"><span class="lg-dot" style="background:var(--g500)"></span>'+esc(cd)+'</span></div>'
    +'</div>';
  // 连续打卡卡
  html+='<div class="card" style="margin:0 16px 14px;padding:18px">'
    +'<div class="streak-row">'+flameSvg+'<div><span class="streak-num">'+streak+'</span><span class="streak-unit">天</span><div class="streak-sub">连续打卡 · 坚持就是胜利</div></div></div>'
    +'<div class="streak-dots">'+dots+'</div>'
    +'</div>';
  // 摄入回顾卡
  html+='<div class="card" style="margin:0 16px 14px;padding:18px">'
    +'<div class="card-head"><span>摄入回顾</span></div>'
    +'<div class="review-line">本周平均摄入 <b>'+avgIn+'</b> kcal <span class="review-vs">对比预算 <b>'+tgt.calories+'</b> kcal</span></div>'
    +'<div class="review-bar"><span class="rb-name" style="color:'+myColor+'">'+activePerson+'</span><div class="rb-track"><div class="rb-fill" style="width:'+avgPct+'%;background:'+myColor+'"></div></div><span class="rb-pct">'+avgPct+'%</span></div>'
    +'</div>';
  // 记录体重
  html+='<div class="card" style="margin:0 16px 14px;padding:16px">'
    +'<div class="card-head"><span>记录体重</span></div>'
    +'<div class="weight-input-row" style="margin:0"><div class="wir-col" style="border-color:'+(activePerson==='W'?'var(--p200)':'var(--g200)')+'">'
    +'<span class="wir-curr">最新 '+(myLatest?myLatest.weight+' kg':'暂无')+'</span>'
    +'<div class="wir-input"><input id="wirW" type="number" step="0.1" placeholder="kg" style="flex:1"><button onclick="recordWeight(\''+activePerson+'\',document.getElementById(\'wirW\').value)" style="background:'+myColor+';color:#fff;border:none;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer">记录</button></div></div></div>'
    +'</div>';
  return html;
}
function setDataView(m){ dataViewMode=m; renderFitnessContent(); }
function setTrendRange(r){ dataTrendRange=r; renderFitnessContent(); }
function renderWeightTable(){
  const dates=[...new Set(DATA.weightLog.map(w=>w.date))].sort().reverse().slice(0,30);
  if(!dates.length) return '<div class="empty">暂无体重记录</div>';
  let rows='';
  dates.forEach(d=>{
    const w=DATA.weightLog.find(x=>x.date===d&&x.person==='W');
    const c=DATA.weightLog.find(x=>x.date===d&&x.person==='C');
    rows+='<tr><td>'+d+'</td><td style="color:var(--p500);font-weight:700">'+(w?w.weight:'—')+'</td><td style="color:var(--g500);font-weight:700">'+(c?c.weight:'—')+'</td></tr>';
  });
  return '<table class="dtable"><tr><th>日期</th><th>'+esc(getS('wDisplay','W'))+' (kg)</th><th>'+esc(getS('cDisplay','C'))+' (kg)</th></tr>'+rows+'</table>';
}
function drawWeightChart(){
  const cv=$('weightChart');
  if(!cv) return;
  let dates=[...new Set(DATA.weightLog.map(w=>w.date))].sort();
  if(dates.length<2){ cv.outerHTML='<div class="empty">至少记录 2 天体重后显示趋势图</div>'; return; }
  const cutoff=addDays(today(),-(dataTrendRange-1));
  const viewDates=dates.filter(d=>d>=cutoff);
  const useDates=viewDates.length>=2?viewDates:dates;
  const dpr=window.devicePixelRatio||1;
  const W=cv.clientWidth, H=200;
  cv.width=W*dpr; cv.height=H*dpr;
  const ctx=cv.getContext('2d'); ctx.scale(dpr,dpr);
  const pad={l:38,r:14,t:14,b:26};
  const cw=W-pad.l-pad.r, ch=H-pad.t-pad.b;
  const all=DATA.weightLog.filter(w=>useDates.includes(w.date)).map(w=>w.weight);
  const min=Math.min(...all)-0.5, max=Math.max(...all)+0.5;
  const x=i=>pad.l+cw*(useDates.length===1?0.5:i/(useDates.length-1));
  const y=v=>pad.t+ch*(1-(v-min)/(max-min));
  ctx.strokeStyle='#EDEAE4'; ctx.lineWidth=1;
  for(let i=0;i<=4;i++){ const gy=pad.t+ch*i/4; ctx.beginPath(); ctx.moveTo(pad.l,gy); ctx.lineTo(W-pad.r,gy); ctx.stroke();
    ctx.fillStyle='#B5AFA5'; ctx.font='10px sans-serif'; ctx.textAlign='right';
    ctx.fillText((max-(max-min)*i/4).toFixed(1),pad.l-5,gy+3); }
  ctx.textAlign='center';
  const step=Math.max(1,Math.ceil(useDates.length/7));
  useDates.forEach((d,i)=>{ if(i%step===0||i===useDates.length-1){ ctx.fillStyle='#B5AFA5'; ctx.fillText(d.slice(5),x(i),H-8); } });
  [['W','#DE6B48'],['C','#504B43']].forEach(([person,color])=>{
    const pts=useDates.map((d,i)=>{ const w=DATA.weightLog.find(z=>z.date===d&&z.person===person); return w?{x:x(i),y:y(w.weight)}:null; }).filter(Boolean);
    if(pts.length<1) return;
    ctx.strokeStyle=color; ctx.lineWidth=2.5; ctx.lineJoin='round'; ctx.beginPath();
    pts.forEach((p,i)=>{ if(i===0)ctx.moveTo(p.x,p.y); else ctx.lineTo(p.x,p.y); });
    ctx.stroke();
    ctx.fillStyle=color;
    pts.forEach(p=>{ ctx.beginPath(); ctx.arc(p.x,p.y,3.5,0,7); ctx.fill(); });
  });
}

function renderPlanPage(){
  ensurePlan();
  const pName=activePerson==='W'?getS('wDisplay','W'):getS('cDisplay','C');
  // 只看当前角色的任务（含 both）
  const myTasks=DATA.planTasks.filter(t=>t.person===activePerson||t.person==='both');
  const dates=[...new Set(myTasks.map(t=>t.date))].sort();
  const start=getS('planStart','')||today();
  const total=myTasks.length;
  const doneAll=myTasks.filter(t=>t.done).length;
  const pct=total?Math.round(doneAll/total*100):0;
  let html='<div class="section-title">'+esc(pName)+' 的计划 · 起始 '+start+'</div>';
  // 今日进度优先，累计放小字（不再一上来就 3% 劝退）
  const td0=today();
  const todayTasks=myTasks.filter(t=>t.date===td0);
  const todayDone=todayTasks.filter(t=>t.done).length;
  const todayPct=todayTasks.length?Math.round(todayDone/todayTasks.length*100):0;
  html+='<div class="plan-progress"><div class="pp-bar"><div class="pp-fill" style="width:'+todayPct+'%"></div></div><div class="pp-text">今日完成 '+todayDone+'/'+todayTasks.length+' 项 · 累计 '+doneAll+'/'+total+' 项</div></div>';
  html+='<div class="plan-enc">'+planEncouragement(todayPct)+'</div>';
  // 计划 / 实际 切换
  html+='<div class="seg"><div class="'+(planView==='plan'?'on':'')+'" onclick="setPlanView(\'plan\')">计划</div><div class="'+(planView==='actual'?'on':'')+'" onclick="setPlanView(\'actual\')">实际记录</div></div>';
  if(planView==='actual'){
    const td=today();
    const myRec=DATA.fitness.filter(r=>r.date===td&&r.person===activePerson);
    const st=personStats(activePerson,td);
    const cls=activePerson==='W'?'p':'g';
    html+='<div class="actual-box"><div class="ab-person" style="border-color:var(--'+cls+'200)"><div class="ab-name" style="color:var(--'+cls+'600)">'+esc(pName)+'</div><div class="ab-kcal">净摄入 '+(st.calIn-st.calOut)+' kcal</div><div class="ab-list">'+(myRec.length?myRec.map(r=>'<div class="r"><span>'+r.time+' '+esc(r.content)+'</span><span>'+(r.calories||'')+'</span></div>').join(''):'<div class="r">今日暂无记录</div>')+'</div></div></div>';
    html+='<div style="margin:12px 16px"><button class="btn-outline btn-sm" onclick="openAddPlanTask()">+ 添加计划任务</button> <button class="btn-outline btn-sm" onclick="resetPlan()">重置计划</button></div>';
    return html;
  }
  html+='<div style="margin:0 16px 12px"><button class="btn-outline btn-sm" onclick="openAddPlanTask()">+ 添加任务</button> <button class="btn-outline btn-sm" onclick="resetPlan()">重置计划</button></div>';
  const td=today();
  dates.forEach((d,i)=>{
    const tasks=myTasks.filter(t=>t.date===d);
    const done=tasks.filter(t=>t.done).length;
    html+='<div class="plan-day'+(d===td?' open':'')+'">'
      +'<div class="plan-day-header" onclick="this.parentElement.classList.toggle(\'open\')"><span>'+d+' · 第'+(i+1)+'天'+(d===td?'（今天）':'')+'</span><span style="font-size:12px;color:var(--tx3)">'+done+'/'+tasks.length+'</span></div>'
      +'<div class="plan-day-body">'
      +tasks.map(t=>{
        const name=t.person==='both'?'一起':pName;
        return '<div class="plan-task"><span class="pt-check'+(t.done?' done':'')+'" onclick="togglePlanTask(\''+t.id+'\')"></span><span style="flex:1;'+(t.done?'text-decoration:line-through;color:var(--tx3)':'')+'"><span class="badge badge-'+(t.person==='W'?'w':t.person==='C'?'c':'w')+'">'+name+'</span> '+esc(t.content)+'</span></div>';
      }).join('')
      +'</div></div>';
  });
  return html;
}
function setPlanView(v){ planView=v; renderFitnessContent(); }
function planEncouragement(pct){
  if(pct===100) return '🎉 全部完成！你们今天把计划变成了现实，太强了，一起庆祝一下～';
  if(pct>=70) return '💪 进度 '+pct+'%，只差一点点，今天稳稳收尾！';
  if(pct>=40) return '🌿 已完成 '+pct+'%，保持节奏，剩下的慢慢来～';
  if(pct>0) return '🌱 刚起步 '+pct+'%，没关系，每一步都算数，继续加油！';
  return '✨ 新的一天，计划已就位，从第一项开始吧～';
}
function ensurePlan(){
  if(DATA.planTasks.length) return;
  const start=getS('planStart','')||today();
  if(!getS('planStart','')) setS('planStart',start);
  const tpl=[
    ['早餐高蛋白（鸡蛋/牛奶）','快走30分钟','记录三餐热量'],
    ['午餐七分饱','晚餐后散步20分钟','记录体重'],
    ['戒掉含糖饮料','拉伸15分钟','多喝水2000ml'],
    ['早餐粗粮代替精米面','有氧30分钟','早睡23点前'],
    ['晚餐减半','双人互相监督打卡','复盘本周数据']
  ];
  for(let i=0;i<15;i++){
    const d=addDays(start,i);
    const day=tpl[i%tpl.length];
    DATA.planTasks.push({id:uid(),date:d,person:'W',content:day[0],done:false});
    DATA.planTasks.push({id:uid(),date:d,person:'C',content:day[1],done:false});
    DATA.planTasks.push({id:uid(),date:d,person:'both',content:day[2],done:false});
  }
  saveData();
}
function togglePlanTask(id){ const t=DATA.planTasks.find(x=>x.id===id); if(t){t.done=!t.done; saveData(); renderFitnessContent();} }
function openAddPlanTask(){
  openModal('<div class="modal-title">添加计划任务</div>'
    +'<div class="set-row"><label>日期</label><input id="mPlanDate" type="date" value="'+today()+'"></div>'
    +'<div class="set-row"><label>归属</label><select id="mPlanPerson"><option value="W">'+esc(getS('wDisplay','W'))+'</option><option value="C">'+esc(getS('cDisplay','C'))+'</option><option value="both">一起</option></select></div>'
    +'<div class="set-row"><label>任务内容</label><input id="mPlanContent" placeholder="例如：跳绳1000个"></div>'
    +'<div class="modal-btns"><button class="mb-cancel" onclick="closeModal()">取消</button><button class="mb-ok" onclick="savePlanTask()">保存</button></div>');
}
function savePlanTask(){
  const d=$('mPlanDate').value, p=$('mPlanPerson').value, c=$('mPlanContent').value.trim();
  if(!d||!c) return toast('请填写完整');
  DATA.planTasks.push({id:uid(),date:d,person:p,content:c,done:false});
  saveData(); closeModal(); renderFitnessContent();
}
function resetPlan(){
  if(!confirm('确定重置 15 天计划？将从今天开始重新生成。')) return;
  DATA.planTasks=[]; setS('planStart',today()); ensurePlan(); renderFitnessContent();
}

// ---- Fitness AI Advisor ----
function buildFitDataSummary(){
  const wd=getS('wDisplay','W'), cd=getS('cDisplay','C');
  let lines=['【近7天数据】'];
  ['W','C'].forEach(p=>{
    const name=p==='W'?wd:cd;
    let inSum=0,outSum=0,days=0;
    for(let i=0;i<7;i++){
      const d=addDays(today(),-i);
      const st=personStats(p,d);
      if(st.recs.length){ inSum+=st.calIn; outSum+=st.calOut; days++; }
    }
    const wls=DATA.weightLog.filter(w=>w.person===p).slice(-3);
    lines.push(name+'：'+(days?('近'+days+'天平均摄入'+Math.round(inSum/days)+'kcal/天，消耗'+Math.round(outSum/days)+'kcal/天'):'近7天无记录')+(wls.length?('；近期体重：'+wls.map(w=>w.date.slice(5)+'='+w.weight+'kg').join('，')):'；无体重记录'));
    // 今日宏量
    const tm=calcTodayMacros(p);
    const tgt=dailyMacroTargets(p);
    if(tm.calIn>0){
      lines.push(name+' 今日营养素：蛋白质'+tm.protein+'g(目标'+tgt.protein+') 脂肪'+tm.fat+'g(目标'+tgt.fat+') 碳水'+tm.carbs+'g(目标'+tgt.carbs+') 纤维'+tm.fiber+'g(目标'+tgt.fiber+')·BMR='+calcBMR(p)+' TDEE='+calcTDEE(p)+' BMI='+calcBMI(p));
    }
  });
  return lines.join('\n');
}
function renderFitAI(){
  const withData=getS('fitAIWithData',true);
  let html='<div class="section-title">AI 减脂顾问</div>'
    +'<div class="quick-prompts">'
    +'<button onclick="fitQuickAsk(\'分析一下我们今天截止到现在的饮食摄入，给出晚餐建议\')">分析今日饮食</button>'
    +'<button onclick="fitQuickAsk(\'为我们两个人推荐明天的减脂餐单（早餐/午餐/晚餐），尽量中式家常\')">推荐明日餐单</button>'
    +'<button onclick="fitQuickAsk(\'100克米饭、一个鸡腿、一杯奶茶分别大概多少热量？\')">热量估算</button>'
    +'<button onclick="fitQuickAsk(\'我们只有一个哑铃，在家能做哪些双人减脂训练？\')">运动建议</button>'
    +'</div>'
    +'<div class="ai-toggle"><div class="switch'+(withData?' on':'')+'" onclick="toggleFitData()"></div><span>发送时携带近 7 天饮食/体重数据（顾问建议更精准）</span></div>'
    +'<div class="chat-container"><div class="chat-msgs" id="chatMsgs">'+renderFitMsgs()+'</div>'
    +'<div class="chat-input-row"><input id="fitAiInput" placeholder="问 AI 顾问任何减脂问题..." onkeydown="if(event.key===\'Enter\')sendFitAI()"><button onclick="sendFitAI()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div></div>'
    +'<button class="btn-outline btn-sm" style="display:block;margin:12px auto" onclick="clearFitAI()">清空对话</button>';
  return html;
}
function toggleFitData(){ setS('fitAIWithData',!getS('fitAIWithData',true)); renderFitnessContent(); }
function renderFitMsgs(){
  if(!DATA.aiChatFit.length){
    return '<div class="chat-msg ai">你好！我是你们的双人减脂顾问。我可以：\n\n1. 分析饮食记录并给出建议\n2. 估算食物热量\n3. 推荐减脂餐单和运动\n4. 解读体重趋势\n\n开启上方"携带数据"后，我会结合你们近7天的真实记录来回答～</div>';
  }
  return DATA.aiChatFit.slice(-30).map(m=>'<div class="chat-msg '+m.role+'">'+(m.role==='assistant'?md(m.content):esc(m.content))+'<div class="ctime">'+(m.time||'')+'</div></div>').join('');
}
function fitQuickAsk(q){ $('fitAiInput').value=q; sendFitAI(); }
function clearFitAI(){ DATA.aiChatFit=[]; saveData(); renderFitnessContent(); }
let fitAiLoading=false;
async function sendFitAI(){
  const input=$('fitAiInput');
  const text=input.value.trim();
  if(!text||fitAiLoading) return;
  input.value='';
  DATA.aiChatFit.push({role:'user',content:text,time:now()});
  saveData();
  $('chatMsgs').innerHTML=renderFitMsgs()+'<div class="chat-msg ai" id="fitAiStream">思考中...</div>';
  $('chatMsgs').scrollTop=$('chatMsgs').scrollHeight;
  fitAiLoading=true;
  let sys='你是 W&C 工作台的双人减脂顾问。用户是一对一起减脂的情侣（W 和 C）。请给出实用、具体、中式饮食友好的建议：热量估算给大致范围，餐单给具体菜名和份量，运动建议考虑居家场景。语气温暖鼓励，像朋友一样。回答用中文。';
  if(getS('fitAIWithData',true)) sys+='\n\n'+buildFitDataSummary();
  const msgs=[{role:'system',content:sys},...DATA.aiChatFit.slice(-20).map(m=>({role:m.role,content:m.content}))];
  const streamEl=$('fitAiStream');
  let acc='';
  const res=await callAI(msgs, chunk=>{ acc+=chunk; if(streamEl) streamEl.textContent=acc; $('chatMsgs').scrollTop=$('chatMsgs').scrollHeight; });
  fitAiLoading=false;
  if(res.error){
    DATA.aiChatFit.push({role:'assistant',content:res.error,time:now()});
  } else {
    DATA.aiChatFit.push({role:'assistant',content:acc||res.content||'(无回复)',time:now()});
  }
  saveData(); renderFitnessContent();
}

// ========================================
// ENGLISH MODULE
// ========================================
const ENG_TABS=[
  {k:'learn',label:'今日学习',icon:'<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'},
  {k:'ai',label:'AI老师',icon:'<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'},
  {k:'anki',label:'Anki复习',icon:'<rect x="3" y="4" width="18" height="14" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/>'},
  {k:'history',label:'档案',icon:'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'}
];
function renderEnglishNav(){
  $('nav').innerHTML=ENG_TABS.map(t=>'<div class="nav-item'+(activeTab===t.k?' active':'')+'" onclick="switchEngTab(\''+t.k+'\')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'+t.icon+'</svg><span>'+t.label+'</span></div>').join('');
}
function switchEngTab(tab){ activeTab=tab; if(tab==='anki'){ initAnkiSession(); } renderEnglishNav(); renderEnglishContent(); }
function renderEnglishContent(){
  const c=$('content');
  ensureEngContent(today());
  if(activeTab==='learn') c.innerHTML=renderEngLearning();
  else if(activeTab==='ai') c.innerHTML=renderEngAI();
  else if(activeTab==='anki') c.innerHTML=renderAnki();
  else if(activeTab==='history') c.innerHTML=renderEngHistory();
}

function taskCheck(t){
  return '<span class="pt-check'+(t.done?' done':'')+'" onclick="toggleEngTask(\''+t.id+'\')"></span>';
}
function toggleEngTask(id){ const t=DATA.engTasks.find(x=>x.id===id); if(t){t.done=!t.done; saveData(); renderEnglishContent();} }
function saveEngReview(id,inputId){
  const t=DATA.engTasks.find(x=>x.id===id); const elx=$(inputId);
  if(t&&elx){ t.review=elx.value; saveData(); toast('复盘已保存'); }
}

function renderEngLearning(){
  const td=today();
  const tasks=DATA.engTasks.filter(t=>t.date===td);
  const idx=getDayIndex(td);
  let html='<div class="section-title">今日学习 · '+td+' · 第'+(idx+1)+'天</div>';

  // due anki banner
  const due=getDueCards(td);
  if(due.length){
    html+='<div class="anki-banner"><div><div class="n">'+due.length+'</div><div class="t">张卡片待复习</div></div><button class="anki-go" onclick="switchEngTab(\'anki\')">去复习</button></div>';
  }

  // Stage 1: grammar
  const g=tasks.find(t=>t.type==='grammar');
  if(g){
    try{
      const d=JSON.parse(g.content);
      html+='<div class="card"><div style="font-size:15px;font-weight:800;margin-bottom:10px;display:flex;align-items:center;gap:8px">'+taskCheck(g)+'阶段 1 · 语法框架 <span class="badge badge-lv'+d.lv+'">'+grammarLevelName(d.lv)+'</span></div>'
        +'<div style="font-size:16px;font-weight:800;color:var(--p600);margin-bottom:8px">'+esc(d.t)+'</div>'
        +'<div class="grammar-rule">'+esc(d.r)+'</div>'
        +'<div style="font-size:12px;font-weight:700;color:var(--tx3);margin:8px 0 4px">例句</div>'
        +d.ex.map(e=>'<div class="g-example">'+esc(e)+'</div>').join('')
        +'<div class="g-error"><b>常见错误：</b>'+esc(d.err)+'</div>'
        +'<div class="g-gold">今日金句：'+esc(d.gold)+'</div>'
        +'<div class="input-row"><textarea id="grammarReview_'+g.id+'" rows="2" placeholder="语法复盘 / 自己造一个句子...">'+esc(g.review||'')+'</textarea></div>'
        +'<button class="btn-sm btn-primary" onclick="saveEngReview(\''+g.id+'\',\'grammarReview_'+g.id+'\')">保存复盘</button>'
        +'<button class="btn-sm btn-outline" style="margin-left:8px" onclick="engAskAbout(\'请详细讲解语法点：'+esc(d.t).replace(/'/g,"\\'")+'，给出更多商务场景的例句\')">问AI老师</button>'
        +'</div>';
    }catch(e){}
  }

  // Stage 2: practice
  const p=tasks.find(t=>t.type==='practice');
  if(p){
    try{
      const d=JSON.parse(p.content);
      const ans=p.answer?JSON.parse(p.answer):{fill:[],ec:[],tr:[]};
      html+='<div class="card"><div style="font-size:15px;font-weight:800;margin-bottom:10px;display:flex;align-items:center;gap:8px">'+taskCheck(p)+'阶段 2 · 配套练习 <span style="font-size:11px;color:var(--tx3)">（'+esc(d.title)+'）</span></div>';
      html+='<div style="font-size:13px;font-weight:700;color:var(--tx2);margin:6px 0">一、填空（自动批改）</div>';
      d.fill.forEach((f,i)=>{
        const ua=ans.fill[i]||'';
        const checked=ua!==''&&ans.checked;
        const ok=checked&&ua.toLowerCase().replace(/[.,!?;]/g,'').trim()===f.a.toLowerCase().replace(/[.,!?;]/g,'').trim();
        html+='<div class="prac-q"><div class="qq">'+(i+1)+'. '+esc(f.q)+'</div>'
          +'<input id="pf_'+p.id+'_'+i+'" placeholder="你的答案" value="'+esc(ua)+'">'
          +'<div class="prac-ans'+(checked?(' show '+(ok?'ok':'no')):'')+'" id="pfa_'+p.id+'_'+i+'">'+(checked?((ok?'✓ 正确':'✗ 正确答案：'+esc(f.a))+(ok?'':' <span style="color:var(--tx3)">（已加入Anki）</span>')):'')+'</div>'
          +'</div>';
      });
      html+='<div style="font-size:13px;font-weight:700;color:var(--tx2);margin:12px 0 6px">二、改错（自评）</div>';
      d.ec.forEach((f,i)=>{
        const ua=ans.ec[i]||'';
        html+='<div class="prac-q"><div class="qq">'+(i+1)+'. 改正句子：<b>'+esc(f.q)+'</b></div>'
          +'<input id="pe_'+p.id+'_'+i+'" placeholder="写出改正后的完整句子" value="'+esc(ua)+'">'
          +'<div class="prac-ans ref" id="pea_'+p.id+'_'+i+'">参考答案：'+esc(f.a)+'</div>'
          +'<div class="mark-btns" id="pem_'+p.id+'_'+i+'" style="display:none">'
          +'<button class="right" onclick="markPractice(\''+p.id+'\',\'ec\','+i+',true)">我答对了</button>'
          +'<button class="wrong" onclick="markPractice(\''+p.id+'\',\'ec\','+i+',false)">答错了·存Anki</button></div>'
          +'</div>';
      });
      html+='<div style="font-size:13px;font-weight:700;color:var(--tx2);margin:12px 0 6px">三、翻译（自评）</div>';
      d.tr.forEach((f,i)=>{
        const ua=ans.tr[i]||'';
        html+='<div class="prac-q"><div class="qq">'+(i+1)+'. 译成英文：<b>'+esc(f.q)+'</b></div>'
          +'<input id="pt_'+p.id+'_'+i+'" placeholder="你的翻译" value="'+esc(ua)+'">'
          +'<div class="prac-ans ref" id="pta_'+p.id+'_'+i+'">参考答案：'+esc(f.a)+'</div>'
          +'<div class="mark-btns" id="ptm_'+p.id+'_'+i+'" style="display:none">'
          +'<button class="right" onclick="markPractice(\''+p.id+'\',\'tr\','+i+',true)">我答对了</button>'
          +'<button class="wrong" onclick="markPractice(\''+p.id+'\',\'tr\','+i+',false)">答错了·存Anki</button></div>'
          +'</div>';
      });
      html+='<div style="margin-top:12px"><button class="btn-primary" onclick="checkPractice(\''+p.id+'\')">核对答案</button></div></div>';
    }catch(e){}
  }

  // Stage 3: vocab
  const v=tasks.find(t=>t.type==='vocab');
  if(v){
    try{
      const words=JSON.parse(v.content);
      const theme=words.length?VOCAB_THEMES[words[0].t]:'';
      html+='<div class="card"><div style="font-size:15px;font-weight:800;margin-bottom:10px;display:flex;align-items:center;gap:8px">'+taskCheck(v)+'阶段 3 · 词汇积累 <span class="badge badge-w">'+theme+'</span></div>';
      words.forEach(w=>{
        html+='<div class="vocab-item">'
          +'<div class="v-head"><span class="v-word">'+esc(w.w)+'</span><span class="v-phon">'+esc(w.p)+'</span><span class="v-theme">'+theme+'</span></div>'
          +'<div class="v-mean">'+esc(w.m)+'</div>'
          +'<div class="v-root">词根：'+esc(w.r)+'</div>'
          +'<div class="v-coll">搭配：'+w.c.map(esc).join(' · ')+'</div>'
          +'<div class="v-ex">'+esc(w.e)+'</div>'
          +'<button class="v-save" onclick="vocabToAnki(\''+esc(w.w).replace(/'/g,"\\'")+'\',\''+esc(w.p).replace(/'/g,"\\'")+'\',\''+esc(w.m).replace(/'/g,"\\'")+'\',\''+esc(w.e).replace(/'/g,"\\'")+'\')">存入Anki</button>'
          +'</div>';
      });
      html+='<div class="input-row" style="margin-top:10px"><textarea id="vocabReview_'+v.id+'" rows="2" placeholder="词汇复盘...">'+esc(v.review||'')+'</textarea></div>'
        +'<button class="btn-sm btn-primary" onclick="saveEngReview(\''+v.id+'\',\'vocabReview_'+v.id+'\')">保存复盘</button></div>';
    }catch(e){}
  }

  // Stage 4: anki inline reminder
  html+='<div class="card" style="text-align:center"><div style="font-size:15px;font-weight:800;margin-bottom:6px">阶段 4 · Anki 长期复习</div>'
    +'<div style="font-size:13px;color:var(--tx2);margin-bottom:10px">'+(due.length?('今日还有 <b style="color:#1565C0">'+due.length+'</b> 张卡片待复习'):'今日待复习卡片已完成，太棒了！')+'</div>'
    +'<button class="btn-outline" onclick="switchEngTab(\'anki\')">进入 Anki 复习</button></div>';

  // Speaking
  const s=tasks.find(t=>t.type==='speaking');
  if(s){
    try{
      const d=JSON.parse(s.content);
      html+='<div class="card"><div style="font-size:15px;font-weight:800;margin-bottom:10px;display:flex;align-items:center;gap:8px">'+taskCheck(s)+'口语练习</div>'
        +'<div style="font-weight:800;font-size:14px">'+esc(d.scene)+'</div>'
        +'<div style="font-size:12px;color:var(--tx3);margin:4px 0 8px">'+esc(d.setup)+'</div>'
        +d.lines.map((l,i)=>'<div style="padding:7px 0;font-size:14px;border-bottom:1px dashed var(--border)"><span style="color:var(--tx4);font-size:11px">'+(i+1)+'.</span> '+esc(l)+'</div>').join('')
        +'<div class="input-row" style="margin-top:8px"><textarea id="speakingReview_'+s.id+'" rows="2" placeholder="口语练习复盘...">'+esc(s.review||'')+'</textarea></div>'
        +'<button class="btn-sm btn-primary" onclick="saveEngReview(\''+s.id+'\',\'speakingReview_'+s.id+'\')">保存复盘</button>'
        +'<button class="btn-sm btn-outline" style="margin-left:8px" onclick="engAskAbout(\'请和我模拟对话练习这个场景：'+esc(d.scene).replace(/'/g,"\\'")+'。你扮演客户，我说第一句。\')">和AI模拟对话</button>'
        +'</div>';
    }catch(e){}
  }

  // Article
  const a=tasks.find(t=>t.type==='article');
  if(a){
    try{
      const d=JSON.parse(a.content);
      html+='<div class="card"><div style="font-size:15px;font-weight:800;margin-bottom:10px;display:flex;align-items:center;gap:8px">'+taskCheck(a)+'阅读训练 · 六步法</div>'
        +'<div style="font-weight:800;font-size:15px;margin-bottom:8px">'+esc(d.title)+'</div>'
        +'<div style="font-size:13px;line-height:1.8;background:var(--p50);padding:12px;border-radius:10px;margin-bottom:12px">'+esc(d.text)+'</div>'
        +'<div style="font-weight:700;font-size:13px;margin-bottom:6px">自主阅读六步法</div>'
        +[['扫标题和首末段','快速浏览标题、第一段和最后一段，把握文章主旨。'],['扫每段主题句','通常每段第一句或最后一句是主题句，3秒扫读即可。'],['生词分三色','红=完全不会 | 黄=眼熟但说不出 | 绿=认识但不会用'],['先猜再核对','根据上下文猜测生词意思，然后再查词典验证。'],['翻译自检','选2-3个长句尝试翻译成中文，检查是否真正理解。'],['捞词块存银行','找出文章的好词好句，存入 Anki 日后复用。']].map((s2,i)=>'<div class="step-card"><span class="step-num">'+(i+1)+'</span><div><div class="step-title">'+s2[0]+'</div><div class="step-content">'+s2[1]+'</div></div></div>').join('')
        +'<div style="font-size:13px;font-weight:700;margin:12px 0 6px">把生词/词块存入 Anki</div>'
        +'<div style="display:flex;gap:8px"><input id="ankiWord_'+a.id+'" placeholder="单词/词块" style="flex:1;padding:9px 12px;border-radius:10px;background:var(--p50);font-size:13px"><input id="ankiMean_'+a.id+'" placeholder="释义" style="flex:1;padding:9px 12px;border-radius:10px;background:var(--p50);font-size:13px"><button class="btn-sm btn-primary" onclick="readingToAnki(\''+a.id+'\')">存入</button></div>'
        +'<div class="input-row" style="margin-top:10px"><textarea id="articleReview_'+a.id+'" rows="2" placeholder="阅读复盘 / 好词好句摘录...">'+esc(a.review||'')+'</textarea></div>'
        +'<button class="btn-sm btn-primary" onclick="saveEngReview(\''+a.id+'\',\'articleReview_'+a.id+'\')">保存复盘</button></div>';
    }catch(e){}
  }
  return html;
}

function checkPractice(id){
  const t=DATA.engTasks.find(x=>x.id===id);
  if(!t) return;
  const d=JSON.parse(t.content);
  const ans=t.answer?JSON.parse(t.answer):{fill:[],ec:[],tr:[]};
  d.fill.forEach((f,i)=>{ const elx=$('pf_'+id+'_'+i); ans.fill[i]=elx?elx.value.trim():''; });
  d.ec.forEach((f,i)=>{ const elx=$('pe_'+id+'_'+i); ans.ec[i]=elx?elx.value.trim():''; });
  d.tr.forEach((f,i)=>{ const elx=$('pt_'+id+'_'+i); ans.tr[i]=elx?elx.value.trim():''; });
  ans.checked=true;
  // auto-grade fill; wrong ones to anki
  d.fill.forEach((f,i)=>{
    const ua=(ans.fill[i]||'').toLowerCase().replace(/[.,!?;]/g,'').trim();
    const ca=f.a.toLowerCase().replace(/[.,!?;]/g,'').trim();
    if(ua&&ua!==ca){
      addAnkiCard('填空：'+f.q,'答案：'+f.a,'语法练习错题','error');
    }
  });
  t.answer=JSON.stringify(ans);
  saveData();
  // show answers and mark buttons
  d.fill.forEach((f,i)=>{
    const ua=(ans.fill[i]||'').toLowerCase().replace(/[.,!?;]/g,'').trim();
    const ca=f.a.toLowerCase().replace(/[.,!?;]/g,'').trim();
    const ok=ua!==''&&ua===ca;
    const elx=$('pfa_'+id+'_'+i);
    if(elx){ elx.className='prac-ans show '+(ok?'ok':'no'); elx.innerHTML=ok?'✓ 正确':'✗ 正确答案：'+esc(f.a)+(ans.fill[i]?' <span style="color:var(--tx3)">（已加入Anki）</span>':''); }
  });
  d.ec.forEach((f,i)=>{ const elx=$('pea_'+id+'_'+i); if(elx)elx.classList.add('show'); const mb=$('pem_'+id+'_'+i); if(mb)mb.style.display='flex'; });
  d.tr.forEach((f,i)=>{ const elx=$('pta_'+id+'_'+i); if(elx)elx.classList.add('show'); const mb=$('ptm_'+id+'_'+i); if(mb)mb.style.display='flex'; });
  toast('答案已核对，错题已自动存入 Anki');
}
function markPractice(id, section, i, correct){
  const t=DATA.engTasks.find(x=>x.id===id);
  if(!t) return;
  const d=JSON.parse(t.content);
  if(!correct){
    const item=d[section][i];
    const front=(section==='ec'?'改错：'+item.q:'翻译：'+item.q);
    addAnkiCard(front,'参考：'+item.a,'语法练习错题','error');
    toast('已存入 Anki');
  } else {
    toast('很棒！');
  }
  const mb=$(section==='ec'?'pem_'+id+'_'+i:'ptm_'+id+'_'+i);
  if(mb) mb.innerHTML='<span style="font-size:12px;color:'+(correct?'var(--g500)':'var(--p500)')+'">'+(correct?'已标记为正确':'已存入Anki')+'</span>';
}
function vocabToAnki(w,p,m,e){
  if(addAnkiCard(w+' '+p, m, e, 'vocab')) toast('"'+w+'" 已存入 Anki');
  else toast('该词已在 Anki 中');
}
function readingToAnki(taskId){
  const w=$('ankiWord_'+taskId).value.trim();
  const m=$('ankiMean_'+taskId).value.trim();
  if(!w) return toast('请输入单词/词块');
  if(addAnkiCard(w, m||'(待补充释义)', '来自阅读', 'reading')) toast('已存入 Anki');
  else toast('该卡片已存在');
  $('ankiWord_'+taskId).value=''; $('ankiMean_'+taskId).value='';
}
function engAskAbout(q){
  activeTab='ai';
  renderEnglishNav(); renderEnglishContent();
  setTimeout(()=>{ $('aiInput').value=q; sendEngAI(); },80);
}

// ---- Anki tab ----
function initAnkiSession(){
  ankiQueue=getDueCards(today());
  ankiIdx=0; ankiFlipped=false;
}
function renderAnki(){
  const due=getDueCards(today());
  if(ankiQueue.length===0||ankiIdx>=ankiQueue.length){
    return '<div class="section-title">Anki 复习</div>'
      +'<div class="card" style="text-align:center;padding:40px 20px">'
      +'<div style="font-size:40px;margin-bottom:10px">🎉</div>'
      +'<div style="font-size:16px;font-weight:800;margin-bottom:6px">'+(DATA.ankiCards.length?'今日复习已完成':'Anki 卡片库为空')+'</div>'
      +'<div style="font-size:13px;color:var(--tx3);line-height:1.7">'+(DATA.ankiCards.length?('卡片库共 '+DATA.ankiCards.length+' 张，明天将有新的复习任务'):'在「今日学习」中把词汇、错题、阅读生词存入 Anki')+'</div>'
      +'<button class="btn-outline" style="margin-top:14px" onclick="switchEngTab(\'learn\')">返回学习</button></div>';
  }
  const c=ankiQueue[ankiIdx];
  return '<div class="section-title">Anki 复习</div>'
    +'<div class="anki-progress">第 '+(ankiIdx+1)+' / '+ankiQueue.length+' 张 · 今日剩余 '+due.length+' 张</div>'
    +'<div class="anki-card">'
    +'<div class="anki-src">'+ankiSourceLabel(c.source)+'</div>'
    +'<div class="anki-front">'+esc(c.front)+'</div>'
    +(c.sub&&!ankiFlipped?'<div class="anki-front-sub">'+esc(c.sub)+'</div>':'')
    +(ankiFlipped?'<div class="anki-back"><div class="bm">'+esc(c.back)+'</div>'+(c.sub?'<div class="be">'+esc(c.sub)+'</div>':'')+'</div>':'')
    +'</div>'
    +(ankiFlipped
      ?'<div class="anki-rate">'
      +'<button class="r-again" onclick="rateAnki(0)">再次<span class="hint">1天</span></button>'
      +'<button class="r-hard" onclick="rateAnki(1)">困难<span class="hint">延短</span></button>'
      +'<button class="r-good" onclick="rateAnki(2)">良好<span class="hint">正常</span></button>'
      +'<button class="r-easy" onclick="rateAnki(3)">简单<span class="hint">延长</span></button></div>'
      :'<div style="text-align:center"><button class="btn-primary" onclick="flipAnki()">显示答案</button></div>');
}
function flipAnki(){ ankiFlipped=true; renderEnglishContent(); }
function rateAnki(r){
  const c=ankiQueue[ankiIdx];
  if(!c) return;
  reviewAnkiCard(c.id, r);
  ankiIdx++; ankiFlipped=false;
  renderEnglishContent();
}

// ---- English AI ----
function renderEngAI(){
  return '<div class="section-title">AI 英语老师</div>'
    +'<div class="quick-prompts">'
    +'<button onclick="engQuickAsk(\'请详细讲解今天的语法点，并多给3个商务例句\')">讲语法</button>'
    +'<button onclick="engQuickAsk(\'帮我批改一下我今天写的翻译练习\')">改作文</button>'
    +'<button onclick="engQuickAsk(\'我们来模拟一段客户询价的对话，你扮演客户\')">模拟对话</button>'
    +'<button onclick="engQuickAsk(\' quotation 和 offer 有什么区别？商务中怎么用？\')">词汇辨析</button>'
    +'<button onclick="engQuickAsk(\'教我写一封催款的商务邮件，语气礼貌但坚定\')">商务邮件</button>'
    +'</div>'
    +'<div class="chat-container"><div class="chat-msgs" id="chatMsgs">'+renderEngMsgs()+'</div>'
    +'<div class="chat-input-row"><input id="aiInput" placeholder="问 AI 老师任何英语问题..." onkeydown="if(event.key===\'Enter\')sendEngAI()"><button onclick="sendEngAI()"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div></div>'
    +'<button class="btn-outline btn-sm" style="display:block;margin:12px auto" onclick="clearEngAI()">清空对话</button>';
}
function renderEngMsgs(){
  if(!DATA.aiChatEng.length){
    return '<div class="chat-msg ai">你好！我是你的专属英语老师，精通 Grammar in Use 教材体系，专注商务/外贸英语。我可以：\n\n1. 逐题讲解今天的练习\n2. 展开讲解语法点并出更多同类题\n3. 和你模拟商务对话\n4. 批改作文和翻译\n\n试试上面的快捷按钮，或直接提问～</div>';
  }
  return DATA.aiChatEng.slice(-30).map(m=>'<div class="chat-msg '+m.role+'">'+(m.role==='assistant'?md(m.content):esc(m.content))+'<div class="ctime">'+(m.time||'')+'</div></div>').join('');
}
function engQuickAsk(q){ $('aiInput').value=q; sendEngAI(); }
function clearEngAI(){ DATA.aiChatEng=[]; saveData(); renderEnglishContent(); }
let engAiLoading=false;
async function sendEngAI(){
  const input=$('aiInput');
  const text=input.value.trim();
  if(!text||engAiLoading) return;
  input.value='';
  DATA.aiChatEng.push({role:'user',content:text,time:now()});
  saveData();
  $('chatMsgs').innerHTML=renderEngMsgs()+'<div class="chat-msg ai" id="engAiStream">思考中...</div>';
  $('chatMsgs').scrollTop=$('chatMsgs').scrollHeight;
  engAiLoading=true;
  const g=getDailyGrammar(getDayIndex(today()));
  const sys={role:'system',content:'你是 W&C 工作台的 AI 英语老师，精通 Grammar in Use 教材体系和商务/外贸英语教学。学生目标：工作中与外国客户交流，偏商务外贸方向，重点提升词汇量和口语。今天的语法点是「'+g.t+'」。请用中文为主讲解，例句用英文并附中文翻译。回答耐心细致，鼓励追问。如果学生要求模拟对话，你扮演外国客户/合作伙伴，一句一句来。讲解语法时参考 Grammar in Use 的风格：先规则、再例句、再常见错误。'};
  const msgs=[sys,...DATA.aiChatEng.slice(-20).map(m=>({role:m.role,content:m.content}))];
  const streamEl=$('engAiStream');
  let acc='';
  const res=await callAI(msgs, chunk=>{ acc+=chunk; if(streamEl) streamEl.textContent=acc; $('chatMsgs').scrollTop=$('chatMsgs').scrollHeight; });
  engAiLoading=false;
  if(res.error){
    DATA.aiChatEng.push({role:'assistant',content:res.error,time:now()});
  } else {
    DATA.aiChatEng.push({role:'assistant',content:acc||res.content||'(无回复)',time:now()});
  }
  saveData(); renderEnglishContent();
}

// ---- History ----
function renderEngHistory(){
  const dates=[...new Set(DATA.engTasks.map(t=>t.date))].sort().reverse();
  const typeLabel={grammar:'语法框架',practice:'配套练习',vocab:'词汇积累',speaking:'口语练习',article:'阅读训练'};
  let html='<div class="section-title">学习档案</div>';
  // anki stats card
  const mastered=DATA.ankiCards.filter(c=>c.reps>=3).length;
  html+='<div class="metric-grid">'
    +'<div class="metric"><div class="m-val" style="color:#1565C0">'+DATA.ankiCards.length+'</div><div class="m-label">Anki 卡片总数</div></div>'
    +'<div class="metric"><div class="m-val" style="color:var(--g500)">'+mastered+'</div><div class="m-label">已掌握（复习≥3次）</div></div>'
    +'</div>';
  if(!dates.length) return html+'<div class="empty">暂无学习记录</div>';
  dates.forEach(d=>{
    if(d===today()) return;
    const tasks=DATA.engTasks.filter(t=>t.date===d);
    const done=tasks.filter(t=>t.done).length;
    html+='<div class="plan-day"><div class="plan-day-header" onclick="this.parentElement.classList.toggle(\'open\')"><span>'+d+'</span><span style="font-size:12px;color:var(--tx3)">'+done+'/'+tasks.length+' 完成</span></div>'
      +'<div class="plan-day-body">'
      +tasks.map(t=>'<div class="plan-task"><span class="pt-check'+(t.done?' done':'')+'"></span><span style="flex:1;'+(t.done?'text-decoration:line-through;color:var(--tx3)':'')+'">'+(typeLabel[t.type]||t.type)+'</span>'+(t.review?'<span style="font-size:11px;color:var(--tx3)">复盘:'+esc(t.review.slice(0,20))+'...</span>':'')+'</div>').join('')
      +'</div></div>';
  });
  return html;
}

// ========================================
// SETTINGS
// ========================================
function openSettings(){
  openModal('<div class="modal-title">设置</div>'
    +'<div class="data-mgmt-card">'
    +'<div class="dmc-title">📦 数据管理</div>'
    +'<div class="dmc-stats">记录: '+DATA.fitness.length+'条 | 待确认: '+DATA.pendingFitness.length+'条 | 体重: '+DATA.weightLog.length+'条 | 计划: '+DATA.planTasks.length+'条</div>'
    +'<div class="dmc-warn">每次重新部署 App 后本地数据<b>可能丢失</b>。建议每次部署前点击「导出数据」备份，部署后在下方导入恢复。</div>'
    +'<div class="dmc-btns">'
    +'<button class="btn-ok btn-sm" onclick="exportData()">导出数据备份</button>'
    +'<button class="btn-outline btn-sm" onclick="document.getElementById(\'importFile\').click()">导入数据恢复</button>'
    +'<input type="file" id="importFile" accept=".json" style="display:none" onchange="importData(this)">'
    +'<button class="btn-outline btn-sm" onclick="syncNow()" style="background:var(--p50);border-color:var(--p200);color:var(--p600)">从云端同步</button>'
    +'<button class="btn-outline btn-sm" onclick="pushToCloud()" style="background:#E3F2FD;border-color:#1976D2;color:#1565C0">⬆️ 上传到云端</button>'
    +'</div></div>'
    +'<div class="set-sec-title">① 文本 / 对话模型（AI 顾问、英文老师、晚间总结）</div>'
    +'<div class="set-row"><label>API Key</label><input id="setKey" type="password" value="'+esc(getS('apiKey',''))+'" placeholder="sk-..."><div class="set-hint">仅存储在本地浏览器，不会上传到任何服务器</div></div>'
    +'<div class="set-row"><label>接口地址</label><input id="setEndpoint" value="'+esc(getS('apiEndpoint','https://api.deepseek.com'))+'"><div class="set-hint">已默认 DeepSeek 官方接口（你已充值，境内可用、支持跨域）</div></div>'
    +'<div class="set-row"><label>文本模型</label><select id="setModel">'
    +['deepseek-chat','deepseek-reasoner','gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-3.5-turbo','claude-3-5-sonnet'].map(m=>'<option'+(getS('model','deepseek-chat')===m?' selected':'')+'>'+m+'</option>').join('')
    +'</select></div>'
    +'<div class="modal-btns"><button class="btn-outline btn-sm" id="testAiBtn" onclick="testAIConnection()">测试文本连接</button></div>'
    +'<div id="testAiOut" class="test-out"></div>'
    +'<div class="set-sec-title">② 图片识别模型（拍照识别食物热量，独立配置）</div>'
    +'<div class="set-row"><label>视觉 API Key</label><input id="setVisionKey" type="password" value="'+esc(getS('visionKey',''))+'" placeholder="阿里云 dashscope 的 sk-..."><div class="set-hint">用于拍照识别。视觉接口默认阿里云 dashscope（通义千问），请在 https://dashscope.console.aliyun.com 申请 Key</div></div>'
    +'<div class="set-row"><label>视觉接口地址</label><input id="setVisionEndpoint" value="'+esc(getS('visionEndpoint','https://dashscope.aliyuncs.com/compatible-mode/v1'))+'"></div>'
    +'<div class="set-row"><label>视觉模型</label><select id="setVisionModel">'
    +['qwen3.7-plus','qwen3.7-flash','qwen3.7-flash-2026-07-15','qwen3.6-plus','qwen3.6-flash','qwen3.5-plus','qwen3.5-flash','qwen3-vl-plus','qwen3-vl-flash','qwen-vl-max','qwen-vl-max-latest','qwen-vl-plus','qwen-vl-plus-latest','glm-4v-plus','glm-4v-flash'].map(m=>'<option'+(getS('visionModel','qwen3.7-plus')===m?' selected':'')+'>'+m+'</option>').join('')
    +'</select></div>'
    +'<div class="modal-btns"><button class="btn-outline btn-sm" id="testVisionBtn" onclick="testVisionConnection()">测试视觉连接</button></div>'
    +'<div id="testVisionOut" class="test-out"></div>'
    +'<div class="set-sec-title">③ '+esc(getS('wDisplay','W'))+' / '+esc(getS('cDisplay','C'))+' 显示与体重目标</div>'
    +'<div class="set-row"><label>W 显示名</label><input id="setW" value="'+esc(getS('wDisplay','W'))+'"></div>'
    +'<div class="set-row"><label>C 显示名</label><input id="setC" value="'+esc(getS('cDisplay','C'))+'"></div>'
    +'<div class="set-row" style="display:flex;gap:10px"><div style="flex:1"><label>'+esc(getS('wDisplay','W'))+' 目标体重 (kg)</label><input id="setTW" type="number" step="0.1" value="'+(getS('targetWeight',{W:58,C:72}).W||58)+'"></div><div style="flex:1"><label>'+esc(getS('cDisplay','C'))+' 目标体重 (kg)</label><input id="setTC" type="number" step="0.1" value="'+(getS('targetWeight',{W:58,C:72}).C||72)+'"></div></div>'
    +'<div class="set-sec-title">④ 个人身体档案</div>'
    +'<div class="set-row" style="display:flex;gap:10px"><div style="flex:1"><label>'+esc(getS('wDisplay','W'))+' 身高 (cm)</label><input id="setWH" type="number" value="'+getS('wHeight',160)+'"></div><div style="flex:1"><label>'+esc(getS('cDisplay','C'))+' 身高 (cm)</label><input id="setCH" type="number" value="'+getS('cHeight',175)+'"></div></div>'
    +'<div class="set-row" style="display:flex;gap:10px"><div style="flex:1"><label>'+esc(getS('wDisplay','W'))+' 性别</label><select id="setWG"><option'+(getS('wGender','女')==='男'?' selected':'')+'>男</option><option'+(getS('wGender','女')==='女'?' selected':'')+'>女</option></select></div><div style="flex:1"><label>'+esc(getS('cDisplay','C'))+' 性别</label><select id="setCG"><option'+(getS('cGender','男')==='男'?' selected':'')+'>男</option><option'+(getS('cGender','男')==='女'?' selected':'')+'>女</option></select></div></div>'
    +'<div class="set-row" style="display:flex;gap:10px"><div style="flex:1"><label>'+esc(getS('wDisplay','W'))+' 年龄</label><input id="setWA" type="number" value="'+getS('wAge',25)+'"></div><div style="flex:1"><label>'+esc(getS('cDisplay','C'))+' 年龄</label><input id="setCA" type="number" value="'+getS('cAge',25)+'"></div></div>'
    +'<div class="set-row" style="display:flex;gap:10px"><div style="flex:1"><label>'+esc(getS('wDisplay','W'))+' 活动量</label><select id="setWA2">'+['久坐','轻度','中度','重度'].map(a=>'<option'+(getS('wActivity','轻度')===a?' selected':'')+'>'+a+'</option>').join('')+'</select></div><div style="flex:1"><label>'+esc(getS('cDisplay','C'))+' 活动量</label><select id="setCA2">'+['久坐','轻度','中度','重度'].map(a=>'<option'+(getS('cActivity','轻度')===a?' selected':'')+'>'+a+'</option>').join('')+'</select></div></div>'
    +'<div class="modal-btns"><button class="mb-ok" onclick="saveSettings()">保存设置</button></div>'
    +'<div class="set-sec-title">⑤ 云端同步 — Upstash Redis（免费·实时）</div>'
    +'<div class="set-row"><label>REST URL</label><input id="setUpUrl" value="'+esc(getS('upstashUrl',''))+'" placeholder="https://xxx.upstash.io"><div class="set-hint">去 <a href="https://console.upstash.com" target="_blank">console.upstash.com</a> 用邮箱注册 → 创建 Redis 数据库 → 复制 REST URL</div></div>'
    +'<div class="set-row"><label>REST Token</label><input id="setUpToken" type="password" value="'+esc(getS('upstashToken',''))+'" placeholder="从 Upstash 控制台复制"><div class="set-hint">同一页面的 Read/Write Token</div></div>'
    +'<div class="modal-btns"><button class="btn-outline btn-sm" onclick="syncNow()">从云端同步</button><button class="btn-outline btn-sm" onclick="pushToCloud()">上传到云端</button></div>'+
'<div style="margin-top:10px;text-align:right"><button class="btn-outline btn-sm" style="border-color:#D9534F;color:#D9534F" onclick="clearAllData()">清空全部数据</button></div>');
}
function saveSettings(){
  setS('apiKey',$('setKey').value.trim());
  setS('apiEndpoint',$('setEndpoint').value.trim()||'https://api.deepseek.com');
  setS('model',$('setModel').value);
  setS('visionKey',$('setVisionKey').value.trim());
  setS('visionEndpoint',$('setVisionEndpoint').value.trim()||'https://dashscope.aliyuncs.com/compatible-mode/v1');
  setS('visionModel',$('setVisionModel').value);
  setS('wDisplay',$('setW').value.trim()||'W');
  setS('cDisplay',$('setC').value.trim()||'C');
  const tw=parseFloat($('setTW').value)||58, tc=parseFloat($('setTC').value)||72;
  setS('targetWeight',{W:tw,C:tc});
  setS('wHeight',parseInt($('setWH').value)||160);
  setS('cHeight',parseInt($('setCH').value)||175);
  setS('wGender',$('setWG').value);
  setS('cGender',$('setCG').value);
  setS('wAge',parseInt($('setWA').value)||25);
  setS('cAge',parseInt($('setCA').value)||25);
  setS('wActivity',$('setWA2').value);
  setS('cActivity',$('setCA2').value);
  setS('upstashUrl',$('setUpUrl').value.trim());
  setS('upstashToken',$('setUpToken').value.trim());
  closeModal(); toast('设置已保存'); loadModule(activeModule);
}
function exportData(){
  const blob=new Blob([JSON.stringify(DATA,null,2)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='wc-workbench-backup-'+today()+'.json';
  a.click();
  toast('已导出备份文件');
}
function importData(input){
  const f=input.files[0];
  if(!f) return;
  const r=new FileReader();
  r.onload=()=>{
    try{
      const d=JSON.parse(r.result);
      DATA=deepMerge(JSON.parse(JSON.stringify(DEFAULT_DATA)),d);
      saveData(); closeModal(); loadModule(activeModule); toast('导入成功');
    }catch(e){ toast('文件格式错误'); }
  };
  r.readAsText(f);
}
function clearAllData(){
  if(!confirm('确定清空全部数据？此操作不可恢复，建议先导出备份。')) return;
  localStorage.removeItem(STORAGE_KEY);
  DATA=JSON.parse(JSON.stringify(DEFAULT_DATA));
  saveData(); closeModal(); loadModule(activeModule); toast('已清空');
}

// ========================================
// INIT
// ========================================
loadData();
activeModule=DATA.sidebars[0]||'W&C 健身减脂';
renderSidebar();
loadModule(activeModule);
// 启动后自动从云端拉取最新数据
setTimeout(()=>{
  cloudLoad(remote=>{
    if(remote){
      DATA=deepMerge(JSON.parse(JSON.stringify(DATA)),remote);
      saveData(); renderFitnessContent(); loadModule(activeModule);
    }
  });
},600);
setTimeout(()=>{
  $('splash').classList.add('hide');
  // 空数据检测：如果是空库且非首次使用（有 settings 里的 apiKey 说明之前用过），提示导入
  if(!DATA.fitness.length && !DATA.weightLog.length && !DATA.pendingFitness.length && getS('apiKey','')) {
    setTimeout(()=>{ toast('⚠️ 本地数据为空。如果你之前有备份文件，请在「设置 → 数据管理」中导入恢复。'); }, 800);
  }
},1200);
if('serviceWorker' in navigator && location.protocol.startsWith('http')){
  navigator.serviceWorker.register('sw.js').catch(()=>{});
}
