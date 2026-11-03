import manifest from "../../generated/manifest.json";
import {archiveGroups} from "./archive-navigation.mjs";
export const repository="https://github.com/sfcloud-ai/ai-infra-reports";
export const pages=manifest.pages;
export const preview=manifest.preview;
export const asset=(slug)=>import.meta.env.BASE_URL.replace(/\/$/,"")+"/"+slug;
export const href=(slug="")=>asset(slug?slug+"/":"");
export const localizedPage=p=>p;
export const localizedGroups=(current)=>archiveGroups(pages,current);
