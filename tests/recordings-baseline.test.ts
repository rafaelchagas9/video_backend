import { describe, expect, it } from "bun:test";
import { baselineOrder, baselineScore } from "@/modules/recordings/recordings.baseline";

const proposal = (id: string, start: number, end: number, score: number) => ({ id, start_seconds: start, end_seconds: end, score });

describe("length+score baseline", () => {
  it("ranks long confident proposals above short weak ones", () => {
    const order = baselineOrder([proposal("c1", 0, 40, 0.6), proposal("c2", 100, 1300, 0.9), proposal("c3", 2000, 2300, 0.95)]);
    expect(order).toEqual(["c2", "c3", "c1"]);
  });

  it("never ranks clips added by hand, and breaks ties by time", () => {
    expect(baselineOrder([proposal("c2", 50, 80, 0.7), proposal("added-1", 0, 900, 1), proposal("c1", 0, 30, 0.7)])).toEqual(["c1", "c2"]);
  });

  it("scores the proposed edges as a logit", () => {
    expect(baselineScore({ start_seconds: 0, end_seconds: 600, score: 0.9 })).toBeCloseTo(-6.654 + 0.8134 * Math.log(600) + 1.7894 * 0.9, 2);
  });
});
