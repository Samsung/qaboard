import { format, median } from "../utils";

// The outputs of mathjs' format(value, {precision}), that we used before
describe("format", () => {
  it.each([
    [1234.5, 3, "1230"],
    [123456, 3, "1.23e+5"],
    [99999, 3, "1e+5"],
    [99949, 3, "99900"],
    [0.000123456, 3, "1.23e-4"],
    [0.00123456, 3, "0.00123"],
    [1.005, 3, "1.01"],
    [9.995, 3, "10"],
    [1.5, 3, "1.5"],
    [-0.5, 3, "-0.5"],
    [0, 3, "0"],
    [100, 3, "100"],
    [1e21, 3, "1e+21"],
    [1.5e-7, undefined, "1.5e-7"],
    [0.1 + 0.2, undefined, "0.30000000000000004"],
    [123456, undefined, "1.23456e+5"],
    [NaN, 3, "NaN"],
    [-Infinity, 3, "-Infinity"],
  ])("format(%s, {precision: %s}) = %s", (value, precision, expected) => {
    expect(format(value, { precision })).toBe(expected);
  });
});

describe("median", () => {
  it("ignores missing values", () => {
    expect(median([3, null, 1, undefined, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([null])).toBe(null);
  });
});
