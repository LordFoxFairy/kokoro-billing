import { beforeEach, describe, expect, it, vi } from "vitest";
import { installCanonicalSchema } from "../../scripts/canonical-schema.js";

const state = vi.hoisted(() => {
  const value: { failure: unknown; closeError: Error | undefined } = {
    failure: undefined,
    closeError: undefined,
  };
  return { value, release: vi.fn(), close: vi.fn() };
});

vi.mock("pg", () => ({
  Pool: class {
    on = vi.fn();
    removeListener = vi.fn();
    connect() {
      return Promise.resolve({
        on: vi.fn(),
        removeListener: vi.fn(),
        release: state.release,
        query: () =>
          Promise.resolve().then(() => {
            throw state.value.failure;
          }),
      });
    }
    end() {
      state.close();
      return state.value.closeError === undefined
        ? Promise.resolve()
        : Promise.reject(state.value.closeError);
    }
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.value.closeError = undefined;
});

describe("canonical installer error identity (unit fault injection)", () => {
  it.each([
    undefined,
    null,
    false,
    0,
    "",
    new Error("original installation error"),
  ])(
    "preserves rejection %j through successful and failed close",
    async (failure) => {
      state.value.failure = failure;
      for (const closeError of [undefined, new Error("close failed")]) {
        state.value.closeError = closeError;
        const installing = installCanonicalSchema({
          databaseUrl: "postgresql://fixture@localhost/fixture",
          schemaSql: "SELECT 1;",
        });
        await expect(installing).rejects.toBe(failure);
      }
      expect(state.release).toHaveBeenCalledTimes(2);
      expect(state.close).toHaveBeenCalledTimes(2);
    },
  );
});
