import { describe, expect, it } from "vitest";
import { bytes, count, duration, percent } from "./format";
describe("plain-language formatters", () => {
  it("does not turn missing observations into zero", () => { expect(count(null)).toBe("暂无数据"); expect(percent(undefined)).toBe("暂无数据"); });
  it("formats operational values", () => { expect(bytes(2048)).toBe("2.0 KB"); expect(duration(90000)).toBe("1.5 分钟"); expect(percent(0.5)).toBe("50.0%"); });
});
