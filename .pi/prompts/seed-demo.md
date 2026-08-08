---
description: Build deterministic demo data tailored to visible UI
---
Read the locked schema, golden path, and visible UI requirements. Create the smallest deterministic, idempotent demo dataset that makes every judged screen look active and coherent.

Requirements:
- one known demo identity/workspace only if the auth design supports it safely
- intentional named records for the golden path
- enough historical points for visible charts, but no unused bulk data
- valid relationships and stable timestamps/random seed
- safe reset order and clear protection against production use
- concise creation summary and runtime

Do not change the schema or shared package config without requesting Architect ownership. Run the seed/reset and relevant checks until clean, then document credentials without committing real secrets.
