import { is_same_data, same_pixels_only } from "../utils";

// The viewers show one image when the pixels are the same: say when `qa check-bit-accuracy`, which compares the
// files, wouldn't call them identical
describe("same data", () => {
  const image = (md5, md5_data) => ({ md5, md5_data, st_size: 1 });

  it("compares the pixels of images when both have their hash", () => {
    expect(is_same_data("a.png", image("1", "p"), image("2", "p"))).toBe(true);
    expect(is_same_data("a.png", image("1", "p"), image("1", "q"))).toBe(false);
    expect(is_same_data("a.png", image("1"), image("1", "p"))).toBe(true);
    expect(is_same_data("a.png", image("1"), image("2", "p"))).toBe(false);
  });

  it("says when only the pixels are the same", () => {
    expect(same_pixels_only("a.png", image("1", "p"), image("2", "p"))).toBe(true);
    expect(same_pixels_only("a.png", image("1", "p"), image("1", "p"))).toBe(false);
    expect(same_pixels_only("a.png", image("1"), image("2"))).toBe(false);
    expect(same_pixels_only("a.png", image("1", "p"), image("2", "q"))).toBe(false);
    expect(same_pixels_only("a.png", image("1", "p"), undefined)).toBe(false);
    // .hex files: qa compares their attributes too, like the web app
    expect(same_pixels_only("a.hex", image("1", "p"), image("2", "p"))).toBe(false);
  });
});
