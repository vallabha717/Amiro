import { describe, expect, it } from "vitest";
import catalog from "../../../../../backend/schedule-templates.json";
import en from "../../../messages/en.json";
import hi from "../../../messages/hi.json";
import type { Schedule, ScheduleTemplate } from "@/lib/backend/schedules-api";
import { scheduleFromTemplate, templateIcon } from "./schedule-templates";
import { CalendarClock } from "lucide-react";

const templates = catalog as unknown as ScheduleTemplate[];

describe("schedule template catalog", () => {
  it("has English and Hindi text and a real icon for every template", () => {
    for (const template of templates) {
      for (const messages of [en, hi]) {
        const text = (messages.Schedules.templates as Record<string, Record<string, string>>)[template.id];
        expect(text?.title, template.id).toBeTruthy();
        expect(text?.summary, template.id).toBeTruthy();
        expect(text?.cadence, template.id).toBeTruthy();
      }
      expect(templateIcon(template.icon), template.id).not.toBe(CalendarClock);
    }
  });

  it("has a label for every category and connector need", () => {
    for (const template of templates) {
      expect(en.Schedules.category).toHaveProperty(template.category);
      for (const need of template.needs) expect(en.Schedules.need).toHaveProperty(need);
    }
  });
});

describe("scheduleFromTemplate", () => {
  const template = { id: "week-ahead", name: "Week ahead" } as ScheduleTemplate;
  const schedule = (over: Partial<Schedule>) => ({ name: "Other", ...over }) as Schedule;

  it("matches by recorded template, even after a rename", () => {
    const mine = schedule({ name: "My Mondays", templateId: "week-ahead" });
    expect(scheduleFromTemplate([schedule({}), mine], template, "Week ahead")).toBe(mine);
  });

  it("recognises older schedules by name, in either language", () => {
    const old = schedule({ name: " week ahead " });
    expect(scheduleFromTemplate([old], template, "सप्ताह की योजना")).toBe(old);
    const hindi = schedule({ name: "सप्ताह की योजना" });
    expect(scheduleFromTemplate([hindi], template, "सप्ताह की योजना")).toBe(hindi);
  });

  it("does not claim a schedule that came from another template", () => {
    const other = schedule({ name: "Week ahead", templateId: "weekly-review" });
    expect(scheduleFromTemplate([other], template, "Week ahead")).toBeUndefined();
  });
});
