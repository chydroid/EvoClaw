import { describe, it, expect, beforeEach } from "vitest";
import { MessageTemplateEngine } from "./message-templates";

describe("MessageTemplateEngine", () => {
  let engine: MessageTemplateEngine;

  beforeEach(() => {
    engine = new MessageTemplateEngine();
  });

  describe("variable substitution", () => {
    it("should render simple variables", () => {
      const result = engine.render("Hello {{ name }}!", { name: "World" });
      expect(result).toBe("Hello World!");
    });

    it("should render multiple variables", () => {
      const result = engine.render("{{ greeting }}, {{ name }}!", {
        greeting: "Hi",
        name: "Alice",
      });
      expect(result).toBe("Hi, Alice!");
    });

    it("should leave unmatched variables empty", () => {
      const result = engine.render("Hello {{ missing }}!");
      expect(result).toBe("Hello !");
    });

    it("should render nested object variables", () => {
      const result = engine.render("Port: {{ server.port }}", {
        server: { port: 3000 },
      });
      expect(result).toBe("Port: 3000");
    });

    it("should render nested arrays as comma-separated JSON-like", () => {
      const result = engine.render("Items: {{ items }}", {
        items: [1, 2, 3],
      });
      expect(result).toContain("1,2,3");
    });

    it("should render null as empty string", () => {
      const result = engine.render("{{ val }}", { val: null });
      expect(result).toBe("");
    });

    it("should render zero correctly", () => {
      const result = engine.render("Count: {{ count }}", { count: 0 });
      expect(result).toBe("Count: 0");
    });

    it("should render boolean", () => {
      const result = engine.render("Active: {{ active }}", { active: true });
      expect(result).toBe("Active: true");
    });
  });

  describe("named templates", () => {
    it("should register and render named template", () => {
      engine.register("greeting", "Hello {{ name }} from {{ team }}!");
      const result = engine.renderNamed("greeting", { name: "Bob", team: "dev" });
      expect(result).toBe("Hello Bob from dev!");
    });

    it("should throw for unknown template", () => {
      expect(() => engine.renderNamed("unknown", {})).toThrow("Template not found");
    });

    it("should batch register templates", () => {
      engine.registerAll({
        "t1": "One: {{ a }}",
        "t2": "Two: {{ b }}",
      });
      expect(engine.listTemplates()).toEqual(["t1", "t2"]);
      expect(engine.renderNamed("t1", { a: "1" })).toBe("One: 1");
    });

    it("should unregister template", () => {
      engine.register("tmp", "test");
      expect(engine.unregister("tmp")).toBe(true);
      expect(engine.getTemplate("tmp")).toBeNull();
    });
  });

  describe("conditionals", () => {
    it("should include block when truthy", () => {
      const result = engine.render(
        "{{#if show}}Visible{{/if}}",
        { show: true },
      );
      expect(result).toBe("Visible");
    });

    it("should exclude block when falsy", () => {
      const result = engine.render(
        "{{#if show}}Visible{{/if}}",
        { show: false },
      );
      expect(result).toBe("");
    });

    it("should exclude block when undefined", () => {
      const result = engine.render(
        "{{#if missing}}Visible{{/if}}",
        {},
      );
      expect(result).toBe("");
    });

    it("should support inverse with unless", () => {
      const result = engine.render(
        "{{#unless show}}Hidden{{/unless}}",
        { show: false },
      );
      expect(result).toBe("Hidden");
    });

    it("should negate with ! prefix", () => {
      const result = engine.render(
        "{{#if !empty}}Has content{{/if}}",
        { empty: false },
      );
      expect(result).toBe("Has content");
    });
  });

  describe("iterators", () => {
    it("should iterate over arrays", () => {
      const result = engine.render(
        "{{#each items}}- {{item}}{{/each}}",
        { items: ["a", "b", "c"] },
      );
      expect(result).toContain("- a");
      expect(result).toContain("- b");
      expect(result).toContain("- c");
    });

    it("should iterate with named variable", () => {
      const result = engine.render(
        "{{#each users as user}}{{user.name}},{{/each}}",
        { users: [{ name: "Alice" }, { name: "Bob" }] },
      );
      expect(result).toBe("Alice,Bob,");
    });

    it("should return empty for non-array", () => {
      const result = engine.render(
        "{{#each items}}x{{/each}}",
        { items: "not-an-array" },
      );
      expect(result).toBe("");
    });
  });

  describe("filters", () => {
    it("should apply upper filter", () => {
      const result = engine.render("{{ name | upper }}", { name: "hello" });
      expect(result).toBe("HELLO");
    });

    it("should apply lower filter", () => {
      const result = engine.render("{{ name | lower }}", { name: "HELLO" });
      expect(result).toBe("hello");
    });

    it("should apply capitalize filter", () => {
      const result = engine.render("{{ word | capitalize }}", { word: "hello" });
      expect(result).toBe("Hello");
    });

    it("should apply trim filter", () => {
      const result = engine.render("{{ text | trim }}", { text: "  hi  " });
      expect(result).toBe("hi");
    });

    it("should apply length filter", () => {
      const result = engine.render("Length: {{ text | length }}", { text: "abcde" });
      expect(result).toBe("Length: 5");
    });

    it("should chain variable with filter properly", () => {
      const result = engine.render("{{ name | upper }} world", { name: "hello" });
      expect(result).toBe("HELLO world");
    });
  });

  describe("custom helpers", () => {
    it("should call registered helper", () => {
      engine.registerHelper("reverse", (s: unknown) => String(s).split("").reverse().join(""));
      const result = engine.render("{{ name | reverse }}", { name: "abc" });
      expect(result).toBe("cba");
    });
  });

  describe("HTML/Markdown escaping", () => {
    it("should escape HTML by default in html mode", () => {
      const result = engine.renderHtml("{{ code }}", { code: "<script>alert('xss')</script>" });
      expect(result).not.toContain("<script>");
      expect(result).toContain("&lt;script&gt;");
    });

    it("should not escape in plaintext mode", () => {
      const result = engine.renderPlaintext("{{ code }}", { code: "<div>" });
      expect(result).toBe("<div>");
    });

    it("should escape in html but not in plaintext even with autoEscape", () => {
      const html = engine.renderHtml("{{ x }}", { x: "<b>bold</b>" });
      const plain = engine.renderPlaintext("{{ x }}", { x: "<b>bold</b>" });
      expect(html).not.toBe("<b>bold</b>");
      expect(plain).toBe("<b>bold</b>");
    });
  });

  describe("channel presets", () => {
    it("should render with channel-specific format", () => {
      engine.register("welcome", "Welcome {{ user }}!");
      const result = engine.renderNamed("welcome", { user: "Alice" }, "plaintext");
      expect(result).toBe("Welcome Alice!");
    });
  });

  describe("configure", () => {
    it("should update config", () => {
      engine.configure({ autoEscape: false });
      const result = engine.renderHtml("{{ code }}", { code: "<script>" });
      // With autoEscape false, HTML is not escaped
      expect(result).toBe("<script>");
    });
  });
});