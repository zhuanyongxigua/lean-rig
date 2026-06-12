/**
 * Deep-merge `patch` onto `base`.
 * - Plain objects: recursively merged (base keys preserved, patch keys win on conflict).
 * - Arrays: patch value replaces base value entirely.
 * - Scalars: patch value replaces base value.
 * - null in patch: sets the key to null (explicit null is preserved).
 * Returns a new object; neither argument is mutated.
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };

  for (const key of Object.keys(patch)) {
    const patchVal = patch[key];
    const baseVal = result[key];

    if (
      patchVal !== null &&
      typeof patchVal === "object" &&
      !Array.isArray(patchVal) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      // Both are plain objects — recurse
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        patchVal as Record<string, unknown>
      );
    } else {
      // Array, scalar, or null — patch wins
      result[key] = patchVal;
    }
  }

  return result;
}
