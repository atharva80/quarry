import { describe, expect, it } from "vitest";
import { hasPath, hostOf, matchHosts } from "../src/match";

const assets = [
  { i: "*.example.com", in: true },
  { i: "https://app.example.org/", in: true },
  { i: "https://gitlab.com/gitlab-org/cli/", in: false },
  { i: "admin.example.com", in: false },
  { i: "*.internal.example.com", in: false },
];

describe("scope check", () => {
  it("parses hosts from URLs and lines", () => {
    expect(hostOf("https://User@API.Example.com:8443/x?y")).toBe("api.example.com");
    expect(hostOf("# comment")).toBeNull();
    expect(hostOf("not a host")).toBeNull();
  });
  it("detects path-limited rules", () => {
    expect(hasPath("https://gitlab.com/gitlab-org/cli/")).toBe(true);
    expect(hasPath("https://app.example.org/")).toBe(false);
    expect(hasPath("*.example.com")).toBe(false);
  });
  it("wildcards cover subdomains, deny wins, path-limited denies don't ban hosts", () => {
    const r = matchHosts(
      "a.example.com\nexample.com\nadmin.example.com\nx.internal.example.com\napp.example.org\ngitlab.com\nother.net",
      assets,
    );
    expect(r.in.map((x) => x.host)).toEqual(["a.example.com", "app.example.org"]);
    expect(r.out.map((x) => x.host)).toEqual(["admin.example.com", "x.internal.example.com"]);
    expect(r.unknown).toEqual(["example.com", "gitlab.com", "other.net"]);
  });
  it("caps input size", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `h${i}.example.com`).join("\n");
    const r = matchHosts(many, assets);
    expect(r.in.length).toBeLessThanOrEqual(2000);
  });
});
