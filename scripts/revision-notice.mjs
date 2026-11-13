import {validatePageDelivery,pageNoticeText} from './page-delivery.mjs';
// 修订意图随不可变报告一起审查；正文变化本身不代表需要再次通知。
const fields=['schema_version','date','revision','title','subtitle','articles','entries','images','poster'];
const requireThat=(ok,message)=>{if(!ok)throw Error(message);};
export function validateReportFields(report){
 requireThat(report&&typeof report==='object'&&!Array.isArray(report),'Report object required');
 const paged=report.schema_version==='1.2';
 const revised=report.schema_version==='1.1'||paged&&report.revision>1;
 requireThat(paged||revised||report.schema_version==='1.0','Unknown report schema');
 requireThat(Object.keys(report).sort().join()===[...fields,...(revised?['revision_notice']:[]),...(paged?['page_delivery']:[])].sort().join(),'Unexpected report fields');
 if(paged)validatePageDelivery(report.page_delivery,report.articles,report.date,report.revision);
 if(!revised)return null; // 原有 1.0 报告、包和发送意图保持原字节。
 const notice=report.revision_notice;
 requireThat(Number.isSafeInteger(report.revision)&&report.revision>1,'Revision notice requires a revised edition');
 requireThat(notice&&typeof notice==='object'&&!Array.isArray(notice)&&Object.keys(notice).sort().join()==='kind,summary','Exact revision notice required');
 requireThat((['correction','material_update','maintenance'].includes(notice.kind)||paged&&notice.kind==='page_completion'),'Unknown revision notice kind');
 requireThat(typeof notice.summary==='string'&&notice.summary.trim()===notice.summary&&notice.summary.length>0&&Buffer.byteLength(notice.summary)<=600&&!/[\x00-\x1f\x7f-\x9f<>\u2028\u2029\ufeff\uD800-\uDFFF]/u.test(notice.summary),'Bounded single-line revision summary required');
 if(paged)requireThat(notice.kind==='page_completion'?report.page_delivery.added.length>0:report.page_delivery.added.length===0,'Revision kind must match added pages');
 return notice;
}
export function revisionNoticeText(report){
 const notice=validateReportFields(report);
 requireThat(notice,'Explicit revision policy required');
 if(notice.kind==='maintenance')return '';
 if(notice.kind==='page_completion')return pageNoticeText(report.date,report.articles.map(a=>({...a,url:`https://sfcloud-ai.github.io/ai-infra-reports/${report.date}/${a.id}/`})),report.page_delivery);
 const label=notice.kind==='correction'?'重要更正':'重要更新';
 return `AI Infra 晨报 · ${report.date} · ${label}\n\n${notice.summary}\n\nhttps://sfcloud-ai.github.io/ai-infra-reports/${report.date}/`;
}
