import manifest from "../../generated/manifest.json";
export const repository="https://github.com/sfcloud-ai/ai-infra-reports";
export const pages=manifest.pages;
export const preview=manifest.preview;
export const asset=(slug)=>import.meta.env.BASE_URL.replace(/\/$/,"")+"/"+slug;
export const href=(slug="")=>asset(slug?slug+"/":"");
export const localizedPage=p=>p;
export const localizedGroups=()=>pages.filter(p=>p.kind==="day").map(p=>({title:p.date,slug:p.slug,pages:[p,...pages.filter(a=>a.parent===p.slug)]}));
