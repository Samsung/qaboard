import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";

import { renderWithProviders } from "../../../test-utils";
import SlamOutputCard from "../SlamOutputCard";

// Plotly doesn't run in jsdom: we only check what would be plotted
vi.mock("../../../components/Plot", () => ({
  default: ({ data, config }) => <div data-testid="plot" data-traces={data.map(t => t.name).join(",")} data-cloud={String(!!config.showSendToCloud)} />,
}));

const poses = "t\tx\ty\tz\n0\t0\t0\t0\n1\t1\t1\t1\n2\t2\t2\t2\n";

afterEach(() => vi.unstubAllGlobals());

describe("SlamOutputCard", () => {
  it("plots the new, reference and groundtruth poses", async () => {
    const fetch = vi.fn(async () => new Response(poses, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    renderWithProviders(<SlamOutputCard
      output_new={{ output_dir_url: "/s/new", test_input_path: "a", metrics: { translation_aape: 1 } }}
      output_ref={{ output_dir_url: "/s/ref", test_input_path: "a", metrics: {} }}
    />);
    await waitFor(() => expect(screen.getAllByTestId("plot")).toHaveLength(2));
    const [plot_6dof, plot_3d] = screen.getAllByTestId("plot");
    expect(plot_6dof.dataset.traces).toBe("groundtruth,groundtruth,groundtruth,reference,reference,reference,new,new,new");
    expect(plot_3d.dataset.traces).toBe("groundtruth,reference,new");
    expect(plot_6dof.dataset.cloud).toBe("false");
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual(["/s/new/GT_final.txt", "/s/new/camera_poses_debug.csv", "/s/ref/camera_poses_debug.csv"]);
  });

  it("still shows the new poses when the other files are missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async url => url.startsWith("/s/new/camera") ? new Response(poses) : new Response("", { status: 404 })));
    renderWithProviders(<SlamOutputCard
      output_new={{ output_dir_url: "/s/new", test_input_path: "a", metrics: { translation_aape: 1 } }}
      output_ref={{ output_dir_url: "/s/ref", metrics: {} }}
    />);
    await waitFor(() => expect(screen.getAllByTestId("plot")).toHaveLength(2));
    expect(screen.getAllByTestId("plot")[0].dataset.traces).toBe("new,new,new");
  });
});
