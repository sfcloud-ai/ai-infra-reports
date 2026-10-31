// MetriCraft content loader adapted to validated report snapshots.
import {defineCollection} from "astro:content";
import {glob} from "astro/loaders";
export const collections={docs:defineCollection({loader:glob({pattern:"**/*.md",base:"./generated/docs",generateId:({entry})=>entry.replace(/\.md$/,"")})})};
