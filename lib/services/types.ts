import type { z } from "zod";
import type { formAnswerValueSchema } from "@/types/api";

/** Value a single form answer can hold, matching the locked shared contract. */
export type FormAnswerValue = z.infer<typeof formAnswerValueSchema>;
