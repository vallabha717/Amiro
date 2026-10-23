"use client";

import * as React from "react";
import {
  format,
  subDays,
  startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  isSameDay,
  isWithinInterval,
  isAfter,
  isBefore,
  addMonths,
  subMonths,
  eachDayOfInterval,
  startOfWeek,
  endOfWeek,
  isSameMonth,
} from "date-fns";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  Check,
  RotateCcw,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "ui/popover";
import { Button } from "ui/button";
import { Badge } from "ui/badge";
import { cn } from "@/lib/utils";

export interface DateRangeValue {
  from?: Date;
  to?: Date;
  presetKey?: string;
}

interface DateRangePickerProps {
  value: DateRangeValue;
  onChange: (value: DateRangeValue) => void;
  className?: string;
}

export interface PresetOption {
  key: string;
  label: string;
  badge?: string;
  getRange: () => { from: Date; to: Date };
}

export const PRESET_OPTIONS: PresetOption[] = [
  {
    key: "today",
    label: "Today",
    getRange: () => {
      const now = new Date();
      return { from: startOfDay(now), to: endOfDay(now) };
    },
  },
  {
    key: "yesterday",
    label: "Yesterday",
    getRange: () => {
      const y = subDays(new Date(), 1);
      return { from: startOfDay(y), to: endOfDay(y) };
    },
  },
  {
    key: "7d",
    label: "Last 7 Days",
    badge: "7D",
    getRange: () => {
      const now = new Date();
      return { from: startOfDay(subDays(now, 6)), to: endOfDay(now) };
    },
  },
  {
    key: "30d",
    label: "Last 30 Days",
    badge: "30D",
    getRange: () => {
      const now = new Date();
      return { from: startOfDay(subDays(now, 29)), to: endOfDay(now) };
    },
  },
  {
    key: "90d",
    label: "Last 90 Days",
    badge: "90D",
    getRange: () => {
      const now = new Date();
      return { from: startOfDay(subDays(now, 89)), to: endOfDay(now) };
    },
  },
  {
    key: "this_month",
    label: "This Month",
    getRange: () => {
      const now = new Date();
      return { from: startOfMonth(now), to: endOfDay(now) };
    },
  },
  {
    key: "all",
    label: "All Time",
    getRange: () => {
      return { from: new Date(2023, 0, 1), to: endOfDay(new Date()) };
    },
  },
];

export function DateRangePicker({ value, onChange, className }: DateRangePickerProps) {
  const [isOpen, setIsOpen] = React.useState(false);
  const [viewMonth, setViewMonth] = React.useState<Date>(value.from || new Date());
  const [tempFrom, setTempFrom] = React.useState<Date | undefined>(value.from);
  const [tempTo, setTempTo] = React.useState<Date | undefined>(value.to);
  const [hoveredDate, setHoveredDate] = React.useState<Date | null>(null);

  // Sync temp state when popover opens or prop changes
  React.useEffect(() => {
    setTempFrom(value.from);
    setTempTo(value.to);
    if (value.from) {
      setViewMonth(value.from);
    }
  }, [value, isOpen]);

  const handleSelectPreset = (preset: PresetOption) => {
    const range = preset.getRange();
    onChange({
      from: range.from,
      to: range.to,
      presetKey: preset.key,
    });
    setIsOpen(false);
  };

  const handleDayClick = (day: Date) => {
    if (!tempFrom || (tempFrom && tempTo)) {
      // First click: start new selection
      setTempFrom(day);
      setTempTo(undefined);
    } else if (tempFrom && !tempTo) {
      // Second click: finish selection
      if (isBefore(day, tempFrom)) {
        setTempFrom(day);
        setTempTo(endOfDay(tempFrom));
        onChange({
          from: startOfDay(day),
          to: endOfDay(tempFrom),
          presetKey: "custom",
        });
      } else {
        setTempTo(endOfDay(day));
        onChange({
          from: startOfDay(tempFrom),
          to: endOfDay(day),
          presetKey: "custom",
        });
      }
      setIsOpen(false);
    }
  };

  // Calendar days generation
  const monthStart = startOfMonth(viewMonth);
  const monthEnd = endOfMonth(monthStart);
  const startDate = startOfWeek(monthStart);
  const endDate = endOfWeek(monthEnd);
  const calendarDays = eachDayOfInterval({ start: startDate, end: endDate });

  const activePreset = PRESET_OPTIONS.find((p) => p.key === value.presetKey);

  // Label formatting
  const displayLabel = React.useMemo(() => {
    if (activePreset) {
      if (activePreset.key === "today" || activePreset.key === "yesterday" || activePreset.key === "all") {
        return activePreset.label;
      }
      if (value.from && value.to) {
        return `${activePreset.label} (${format(value.from, "MMM d")} - ${format(value.to, "MMM d")})`;
      }
      return activePreset.label;
    }
    if (value.from && value.to) {
      if (isSameDay(value.from, value.to)) {
        return format(value.from, "MMM d, yyyy");
      }
      return `${format(value.from, "MMM d, yyyy")} - ${format(value.to, "MMM d, yyyy")}`;
    }
    return "Select date range";
  }, [activePreset, value]);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <Popover open={isOpen} onOpenChange={setIsOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            className={cn(
              "justify-start text-left font-normal h-9 bg-background border hover:bg-accent/50 transition-all",
              !value.from && "text-muted-foreground",
            )}
            data-testid="date-range-picker-trigger"
          >
            <CalendarIcon className="mr-2 h-4 w-4 text-primary" />
            <span className="truncate font-medium text-xs sm:text-sm">{displayLabel}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-auto p-0 shadow-xl border bg-popover rounded-xl overflow-hidden"
          align="end"
          sideOffset={8}
        >
          <div className="flex flex-col sm:flex-row divide-y sm:divide-y-0 sm:divide-x divide-border">
            {/* Left Column: Preset Options */}
            <div className="p-3 w-full sm:w-44 flex flex-col gap-1 bg-muted/20">
              <div className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Timeframe
              </div>
              {PRESET_OPTIONS.map((preset) => {
                const isSelected = value.presetKey === preset.key;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => handleSelectPreset(preset)}
                    className={cn(
                      "flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs transition-colors font-medium text-left",
                      isSelected
                        ? "bg-primary text-primary-foreground font-semibold shadow-xs"
                        : "hover:bg-accent hover:text-foreground text-muted-foreground",
                    )}
                  >
                    <span>{preset.label}</span>
                    {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                );
              })}

              <div className="pt-2 mt-auto border-t border-border/60">
                <button
                  type="button"
                  onClick={() => handleSelectPreset(PRESET_OPTIONS[3])} // Default: 30D
                  className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RotateCcw className="size-3" />
                  Reset to 30 Days
                </button>
              </div>
            </div>

            {/* Right Column: Interactive Calendar */}
            <div className="p-4 w-full sm:w-[300px]">
              {/* Month Navigation */}
              <div className="flex items-center justify-between pb-3 mb-2 border-b border-border/50">
                <span className="text-sm font-semibold">
                  {format(viewMonth, "MMMM yyyy")}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md"
                    onClick={() => setViewMonth(subMonths(viewMonth, 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded-md"
                    onClick={() => setViewMonth(addMonths(viewMonth, 1))}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Day Headers (Sun - Sat) */}
              <div className="grid grid-cols-7 gap-1 text-center mb-1">
                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d) => (
                  <div
                    key={d}
                    className="text-[11px] font-medium text-muted-foreground py-1"
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* Day Grid */}
              <div className="grid grid-cols-7 gap-1">
                {calendarDays.map((day) => {
                  const isCurrentMonth = isSameMonth(day, viewMonth);
                  const isToday = isSameDay(day, new Date());
                  const isFuture = isAfter(day, new Date());

                  const isStart = tempFrom && isSameDay(day, tempFrom);
                  const isEnd = tempTo && isSameDay(day, tempTo);
                  const isInRange =
                    tempFrom &&
                    tempTo &&
                    isWithinInterval(day, { start: tempFrom, end: tempTo });

                  const isHoverInRange =
                    tempFrom &&
                    !tempTo &&
                    hoveredDate &&
                    ((isAfter(hoveredDate, tempFrom) &&
                      isWithinInterval(day, { start: tempFrom, end: hoveredDate })) ||
                      (isBefore(hoveredDate, tempFrom) &&
                        isWithinInterval(day, { start: hoveredDate, end: tempFrom })));

                  return (
                    <button
                      key={day.toISOString()}
                      type="button"
                      disabled={isFuture}
                      onClick={() => handleDayClick(day)}
                      onMouseEnter={() => setHoveredDate(day)}
                      onMouseLeave={() => setHoveredDate(null)}
                      className={cn(
                        "h-8 w-full rounded-md text-xs font-medium transition-all relative flex items-center justify-center",
                        !isCurrentMonth && "text-muted-foreground/30",
                        isFuture && "opacity-30 cursor-not-allowed hover:bg-transparent",
                        isToday && !isStart && !isEnd && "border border-primary/40 font-bold",
                        (isStart || isEnd) &&
                          "bg-primary text-primary-foreground font-bold shadow-xs",
                        (isInRange || isHoverInRange) &&
                          !isStart &&
                          !isEnd &&
                          "bg-primary/15 text-primary rounded-none",
                        isStart && tempTo && !isSameDay(tempFrom, tempTo) && "rounded-r-none",
                        isEnd && tempFrom && !isSameDay(tempFrom, tempTo) && "rounded-l-none",
                        !isStart &&
                          !isEnd &&
                          !isInRange &&
                          !isHoverInRange &&
                          !isFuture &&
                          "hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {format(day, "d")}
                    </button>
                  );
                })}
              </div>

              {/* Helper text */}
              <div className="pt-3 mt-3 border-t border-border/50 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>
                  {tempFrom && !tempTo
                    ? "Click second date to complete range"
                    : tempFrom && tempTo
                      ? `${format(tempFrom, "MMM d")} - ${format(tempTo, "MMM d")}`
                      : "Pick start and end date"}
                </span>
                {value.presetKey === "custom" && (
                  <Badge variant="outline" className="text-[10px] h-4 px-1">
                    Custom
                  </Badge>
                )}
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
