import { z } from "zod";

// A non-literal dynamic import poisons the static crawl, so no per-file
// dependency list can be trusted for this file.
const which = process.env["WHICH"] ?? "./limits.js";
export const loadLimits = () => import(which);

export const HandleSchema = z.object({ handle: z.string().min(1) });
