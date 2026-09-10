/** Test precondition: fail where a required fixture value is missing, not later. */
export function assertDefined<T>(value: T): NonNullable<T> {
  if (value === null || value === undefined)
    throw new Error("Required test fixture value is missing");
  return value;
}
