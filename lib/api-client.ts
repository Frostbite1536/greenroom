"use client";

import type { ApiResponse } from "@/types/api";

/**
 * Browser-side helper for the backend API.
 *
 * Every route returns the locked `ApiResponse<T>` envelope from `types/api.ts`,
 * so this normalises transport failures into the same shape. Callers get a
 * discriminated union and never need try/catch.
 */
export type ApiFailureShape = {
  ok: false;
  error: { code: string; message: string; fieldErrors?: Record<string, string[]> };
};

export async function apiPost<T>(
  path: string,
  body: unknown,
): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ApiResponse<T>;
  } catch {
    return {
      ok: false,
      error: { code: "NETWORK_ERROR", message: "Could not reach the server. Check your connection and try again." },
    };
  }
}

/** PATCH helper for small, validated updates such as event and room settings. */
export async function apiPatch<T>(
  path: string,
  body: unknown,
): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ApiResponse<T>;
  } catch {
    return {
      ok: false,
      error: { code: "NETWORK_ERROR", message: "Could not reach the server. Check your connection and try again." },
    };
  }
}

export async function apiDelete<T>(path: string): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(path, { method: "DELETE" });
    return (await res.json()) as ApiResponse<T>;
  } catch {
    return {
      ok: false,
      error: { code: "NETWORK_ERROR", message: "Could not reach the server. Check your connection and try again." },
    };
  }
}

/** Flatten `fieldErrors` into one message per field for inline display. */
export function firstFieldErrors(
  fieldErrors: Record<string, string[]> | undefined,
): Record<string, string> {
  if (!fieldErrors) return {};
  return Object.fromEntries(
    Object.entries(fieldErrors)
      .filter(([, msgs]) => msgs.length > 0)
      .map(([key, msgs]) => [key, msgs[0]]),
  );
}
