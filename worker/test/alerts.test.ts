import { describe, expect, it } from "vitest";
import {
  buildAtom,
  escapeDiscord,
  escapeHtml,
  generateVapidKeys,
  isAllowedPushEndpoint,
  parseDiscordWebhook,
  parseTelegramCommand,
  renderDiscord,
  renderTelegram,
  safeEqual,
  xmlEscape,
} from "../src/alerts";

const TOKEN = "a".repeat(40);
const GOOD = `https://discord.com/api/webhooks/123456789012345678/${TOKEN}`;

describe("parseDiscordWebhook", () => {
  it("accepts discord.com and discordapp.com", () => {
    expect(parseDiscordWebhook(GOOD)).toBe(GOOD);
    const alt = `https://discordapp.com/api/webhooks/123456789012345678/${TOKEN}`;
    expect(parseDiscordWebhook(alt)).toBe(alt);
  });
  it.each([
    ["http", `http://discord.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["other host", `https://example.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["suffix host", `https://discord.com.evil.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["subdomain", `https://ptb.discord.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["userinfo", `https://discord.com@evil.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["userinfo2", `https://user:pw@discord.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["port", `https://discord.com:8443/api/webhooks/123456789012345678/${TOKEN}`],
    ["query", `${GOOD}?wait=true`],
    ["empty query", `${GOOD}?`],
    ["fragment", `${GOOD}#x`],
    ["backslash", `https://discord.com\\@evil.com/api/webhooks/123456789012345678/${TOKEN}`],
    ["non-digit id", `https://discord.com/api/webhooks/abc/${TOKEN}`],
    ["short token", "https://discord.com/api/webhooks/abc/x"],
    ["trailing slash", `${GOOD}/`],
    ["extra path", `${GOOD}/github`],
    ["traversal", `https://discord.com/api/webhooks/123456789012345678/../${TOKEN}`],
    ["whitespace", ` ${GOOD}`],
    ["not a string", 42],
  ])("rejects %s", (_n, v) => {
    expect(parseDiscordWebhook(v)).toBeNull();
  });
});

describe("isAllowedPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-par02p.notify.windows.com/w/?token=abc",
    "https://web.push.apple.com/abc",
  ])("accepts %s", (u) => expect(isAllowedPushEndpoint(u)).toBe(true));
  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.evil.com/x",
    "https://evil.com/fcm.googleapis.com",
    "https://notify.windows.com/x",
    "https://evilnotify.windows.com.evil.com/x",
    "https://fcm.googleapis.com:444/x",
    "https://u:p@fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "not a url",
  ])("rejects %s", (u) => expect(isAllowedPushEndpoint(u)).toBe(false));
});

describe("parseTelegramCommand", () => {
  const code = "0123456789abcdef0123456789abcdef";
  it("parses /start <code>", () => {
    expect(parseTelegramCommand(`/start ${code}`)).toEqual({ cmd: "start", code });
    expect(parseTelegramCommand(`/start@QuarryBot ${code.toUpperCase()}`)).toEqual({ cmd: "start", code });
  });
  it("treats /start without or with a bad code as help", () => {
    expect(parseTelegramCommand("/start")).toEqual({ cmd: "help" });
    expect(parseTelegramCommand("/start short")).toEqual({ cmd: "help" });
    expect(parseTelegramCommand(`/start ${code} extra`)).toEqual({ cmd: "help" });
  });
  it("parses /stop and falls back to help", () => {
    expect(parseTelegramCommand("/stop")).toEqual({ cmd: "stop" });
    expect(parseTelegramCommand("/STOP@QuarryBot")).toEqual({ cmd: "stop" });
    expect(parseTelegramCommand("hello")).toEqual({ cmd: "help" });
    expect(parseTelegramCommand(undefined)).toEqual({ cmd: "help" });
  });
});

describe("escaping", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
  it("escapes XML and strips illegal characters", () => {
    expect(xmlEscape(`a&b<c>"d"'e'\u0000\u0008\u000b ok\n`)).toBe("a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos; ok\n");
  });
  it("escapes Discord markdown and mentions", () => {
    expect(escapeDiscord("@everyone [x](y) *b*")).toBe("\\@everyone \\[x\\]\\(y\\) \\*b\\*");
  });
  it("renders untrusted names safely", () => {
    const m = { title: "T", items: [{ name: "<b>x</b> @everyone", what: "a & b", url: "https://q.test/p/h1/x/" }] };
    expect(renderTelegram(m)).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(renderTelegram(m)).not.toContain("<b>x</b>");
    expect(renderDiscord(m)).toContain("\\@everyone");
    expect(renderDiscord(m).length).toBeLessThanOrEqual(2000);
  });
});

describe("buildAtom", () => {
  it("produces escaped, newest-first entries", () => {
    const xml = buildAtom({
      selfUrl: "https://q.test/api/feed/t.xml",
      siteUrl: "https://q.test",
      now: 1790000000,
      entries: [
        {
          id: "tag:x:1",
          ts: 1790000100,
          title: "A & <B>",
          url: "https://q.test/p/h1/a/?x=1&y=2",
          summary: "</summary><evil/>",
        },
      ],
    });
    expect(xml).toContain("<title>A &amp; &lt;B&gt;</title>");
    expect(xml).toContain('href="https://q.test/p/h1/a/?x=1&amp;y=2"');
    expect(xml).toContain("&lt;/summary&gt;&lt;evil/&gt;");
    expect(xml).not.toContain("<evil/>");
    expect(xml).toContain(`<updated>${new Date(1790000100 * 1000).toISOString()}</updated>`);
  });
  it("is valid with no entries", () => {
    expect(
      buildAtom({ selfUrl: "https://q.test/f", siteUrl: "https://q.test", entries: [], now: 1790000000 }),
    ).toContain("</feed>");
  });
});

describe("crypto helpers", () => {
  it("safeEqual compares strings", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abd")).toBe(false);
    expect(await safeEqual("abc", "abcd")).toBe(false);
  });
  it("generateVapidKeys returns raw P-256 keys in base64url", async () => {
    const k = await generateVapidKeys();
    expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]{86,87}$/);
    expect(k.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
