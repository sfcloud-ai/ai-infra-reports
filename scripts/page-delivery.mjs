// Immutable ready/pending page partition. No IO or authority to send.
export const TOPIC_IDS=['model-serving-gpu','hardware-status','model-architecture-status','embodied-training','small-model-status','inference-engines'];
const LABELS=['模型服务与 GPU 超配','硬件与算力平台','模型与架构','制造业具身智能训练','前沿小模型','推理引擎每日变动'];
const requireThat=(ok,m)=>{if(!ok)throw Error(m);};
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&Object.keys(o).sort().join()===[...k].sort().join();
const line=s=>typeof s==='string'&&s.trim()===s&&s.length>0&&Buffer.byteLength(s)<=300&&!/[\x00-\x1f\x7f-\x9f<>\u2028\u2029\ufeff\uD800-\uDFFF]/u.test(s);
export function validatePageDelivery(value,articles,date,revision){
 requireThat(exact(value,['previous','added','pending']),'Exact page delivery fields required');
 requireThat(Array.isArray(articles)&&articles.length>0&&articles.every(a=>TOPIC_IDS.includes(a.id)),'Ready topic pages required');
 const ready=articles.map(a=>a.id);
 requireThat(new Set(ready).size===ready.length,'Duplicate ready topic');
 requireThat(Array.isArray(value.pending)&&value.pending.every(p=>exact(p,['id','reason'])&&TOPIC_IDS.includes(p.id)&&line(p.reason)),'Bounded pending reasons required');
 const all=[...ready,...value.pending.map(p=>p.id)];
 requireThat(all.length===6&&new Set(all).size===6,'Ready and pending must partition six topics');
 requireThat(Array.isArray(value.added)&&(revision>1||value.added.length>0)&&new Set(value.added).size===value.added.length&&value.added.every(id=>ready.includes(id)),'Added ready pages required');
 requireThat(ready.join()===TOPIC_IDS.filter(id=>ready.includes(id)).join()&&value.added.join()===ready.filter(id=>value.added.includes(id)).join()&&value.pending.map(p=>p.id).join()===TOPIC_IDS.filter(id=>!ready.includes(id)).join(),'Canonical page order required');
 if(revision===1)requireThat(value.previous===null&&value.added.join()===ready.join(),'Initial page set differs');
 else requireThat(exact(value.previous,['request_id','bundle_sha256'])&&value.previous.request_id===`morning-${date.replaceAll('-','')}-r${revision-1}`&&typeof value.previous.bundle_sha256==='string'&&value.previous.bundle_sha256.length===64&&/^[a-f0-9]{64}$/.test(value.previous.bundle_sha256),'Bound previous revision required');
 return value;
}
export function pageNoticeText(date,articles,pages){
 let text=`AI Infra 晨报 · ${date}${pages.previous?' · 补充':''}\n\n`+articles.filter(a=>pages.added.includes(a.id)).map(a=>`${a.title}\n${a.url}`).join('\n\n');
 if(pages.pending.length)text+='\n\n晨报说明：'+pages.pending.map(p=>`${LABELS[TOPIC_IDS.indexOf(p.id)]}：${p.reason}`).join('；')+'。下一次定时任务（下一小时 :20）继续补齐。';
 return text;
}
export function validatePageProgressReport(previous,next){
 requireThat(previous?.page_delivery&&next?.page_delivery,'Page continuation requires the original partition');
 requireThat(previous.date===next.date&&next.revision===previous.revision+1,'Page continuation date/revision differs');
 const old=new Map(previous.articles.map(a=>[a.id,a]));
 const now=new Map(next.articles.map(a=>[a.id,a]));
 requireThat([...old].every(([id,a])=>now.has(id)&&['id','title','summary','sha256'].every(k=>now.get(id)[k]===a[k])),'Already delivered pages cannot be changed by completion');
 const added=next.articles.filter(a=>!old.has(a.id)).map(a=>a.id);
 requireThat(added.join()===next.page_delivery.added.join(),'Completion must contain exactly new pages');
 const pending=new Set(previous.page_delivery.pending.map(p=>p.id));
 requireThat(added.every(id=>pending.has(id))&&next.page_delivery.pending.map(p=>p.id).join()===previous.page_delivery.pending.filter(p=>!added.includes(p.id)).map(p=>p.id).join(),'Completion pending set differs');
}

// A correction changes already published content, not the set of delivered pages.
export function validatePageCorrectionReport(previous,next){
 requireThat(previous?.page_delivery&&next?.page_delivery,'Page correction requires the original partition');
 requireThat(previous.date===next.date&&next.revision===previous.revision+1,'Page correction date/revision differs');
 requireThat(['correction','material_update','maintenance'].includes(next.revision_notice?.kind),'Explicit correction policy required');
 requireThat(next.page_delivery.added.length===0,'Corrections cannot announce completed pages');
 requireThat(next.articles.map(a=>a.id).join()===previous.articles.map(a=>a.id).join(),'Corrections cannot change ready pages');
 requireThat(JSON.stringify(next.page_delivery.pending)===JSON.stringify(previous.page_delivery.pending),'Corrections must preserve pending pages and reasons');
}
