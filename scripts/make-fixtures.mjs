import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {digest,json,validateArchive} from "./archive.mjs";
const root=path.resolve("tests/fixtures/archive"),files=new Map();
const samples=[{"date":"2026-10-31","title":"推理系统：从缓存效率到调度边界","subtitle":"合成样例 · 拆解 KV cache、调度与可复现实验","articles":[["kv-cache","KV cache：容量之外的命中条件","从共享前缀到生命周期，解释缓存收益取决于哪些条件。","## 机制：前缀共享与生命周期\n\nKV cache 保存已计算的注意力状态。复用前缀可以减少重复计算，但命中率还取决于请求分布、缓存保留时间与淘汰策略。这里的文字是合成样例，用于测试中文全文检索和章节导航。\n\n## 实验条件\n\n比较时应固定模型、精度、输入输出长度、并发和硬件。只报告吞吐量，无法说明首 token 延迟或长尾请求的变化。\n\n| 维度 | 需要记录的条件 |\n| --- | --- |\n| 工作负载 | 输入分布、前缀复用率 |\n| 调度策略 | 批大小、排队与抢占 |\n| 资源预算 | 显存、缓存驻留时间 |\n\n## 限制与工程判断\n\n缓存不是免费容量。数据变化、跨租户隔离和淘汰策略都会影响复用收益。不要将某组实验中的提升直接推广到全部场景。\n\n## 来源\n\n这是界面测试样例，并非研究结论。阅读 [vLLM 文档](https://docs.vllm.ai/) 了解实际项目。\n"],["scheduler","调度：吞吐量与尾延迟之间","将吞吐、排队和请求公平性放在同一个实验条件中理解。","## 调度如何影响请求\n\n连续批处理允许请求在不同时间进入执行队列。平均吞吐量并不能代替单个请求等待时间。\n\n## 实验条件\n\n合成样例关键词：continuous batching。测试英文搜索应忽略大小写，并定位到这个章节。\n\n## 限制\n\n这里没有实测数字。真实报告需要记录基准版本、硬件、负载与失败场景。\n\n## 来源\n\n查看 [vLLM 文档](https://docs.vllm.ai/)；本页仅作导航和检索测试。\n"]]},{"date":"2026-10-30","title":"训练与通信：先理解瓶颈所在","subtitle":"合成样例 · 通信重叠的观察方法与限制","articles":[["communication","通信重叠：何时真正缩短迭代","用时间线解释计算与通信重叠的适用条件。","## 机制\n\n通信重叠需要有独立计算可以执行。图中看似重叠的区间，不一定减少关键路径上的等待。\n\n## 实验条件与限制\n\n记录拓扑、消息大小、计算图和同步点。这个样例只测试站点排版，不代表具体性能结论。\n\n## 来源\n\n可参考 [PyTorch 文档](https://docs.pytorch.org/)。\n"]]}];

for(const sample of samples){
 const dir="reports/"+sample.date+"/r1/";
 const articles=sample.articles.map(([id,title,summary,body])=>{const b=Buffer.from(body+(id==="scheduler"?"\n"+String.fromCharCode(96).repeat(3)+"text\n用于回归未闭合代码块的合成示例。\n":""));files.set(dir+"articles/"+id+".md",b);return {id,title,summary,sha256:digest(b)};});
 const r={schema_version:"1.0",date:sample.date,revision:1,title:sample.title,subtitle:sample.subtitle,articles,entries:articles.map(a=>({id:sample.date+"-"+a.id,event_key:a.id,title:a.title,summary:a.summary,source_urls:[a.id==="communication"?"https://docs.pytorch.org/":"https://docs.vllm.ai/"],update_of:null,article_id:a.id})),images:[],poster:null};
 files.set(dir+"report.json",Buffer.from(json(r)));
}
files.set("reports/index.json",Buffer.from(json(validateArchive(files,{checkIndex:false}).index)));
for(const [p,b]of files){const dest=path.join(root,p);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,b);}
console.log("Wrote synthetic fixtures");
