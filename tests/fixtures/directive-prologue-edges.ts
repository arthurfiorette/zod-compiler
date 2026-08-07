#!/usr/bin/env node
// A leading line comment, then a block comment, then two directives.
/* the prologue survives both */
"use strict";
"use server";

import { z } from "zod";

export const TaskSchema = z.object({
  id: z.string().min(1),
  done: z.boolean(),
});
