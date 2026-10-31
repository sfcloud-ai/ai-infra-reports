import reportHeadings from "./scripts/rehype-headings.mjs";
// Adapted from MetriCraft 728caaa. Apache-2.0; see NOTICE.
import {defineConfig} from "astro/config";
import {unified} from "@astrojs/markdown-remark";
import manifest from "./generated/manifest.json" with {type:"json"};
import reportMarkdown from "./scripts/remark-reports.mjs";
export default defineConfig({
 site:"https://sfcloud-ai.github.io", base:"/ai-infra-reports", trailingSlash:"always", output:"static",
 outDir:process.env.REPORT_PREVIEW==="1"?"./dist-preview":"./dist",
 markdown:{processor:unified({rehypePlugins:[reportHeadings],remarkPlugins:[[reportMarkdown,{assets:manifest.assets,articleDirs:manifest.articleDirs}]]}),shikiConfig:{themes:{light:"github-light",dark:"github-dark"},wrap:false}},
 devToolbar:{enabled:false},
});
