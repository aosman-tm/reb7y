import { useState } from "react";
import {
  Modal,
  BlockStack,
  InlineStack,
  ChoiceList,
  TextField,
  Text,
  Banner,
  Box,
  Badge,
  Divider,
} from "@shopify/polaris";
import {
  applyPriceChange,
  toPeriods,
  describePeriod,
  type PriceEntry,
  type PriceChange,
} from "../lib/priceTimeline";

/** Mirrors ApplyMode in app/lib/costHistory.server.ts. */
export type ApplyMode = "today" | "date" | "range" | "correct";

/**
 * Asks when a cost change should start counting.
 *
 * Without this the merchant cannot tell the difference between "the supplier
 * raised the price", "it was different for a while", and "I typed the wrong
 * number" — and all three would rewrite the profit of every past order.
 *
 * The preview underneath is the important part: dates are hard to reason about
 * in the abstract, so the modal shows the exact price periods that will result
 * before anything is saved. It is computed with applyPriceChange, the same
 * function the server uses to store the change, so it cannot be misleading.
 */
export function PriceChangeModal({
  open,
  itemName,
  oldValue,
  newValue,
  currency,
  today,
  history,
  earliestDay = "2000-01-01",
  onCancel,
  onConfirm,
}: {
  open: boolean;
  itemName: string;
  oldValue: number;
  newValue: number;
  currency: string;
  today: string;
  /** Prices already recorded, oldest first. */
  history: PriceEntry[];
  earliestDay?: string;
  onCancel: () => void;
  onConfirm: (mode: ApplyMode, from: string, to: string) => void;
}) {
  const [mode, setMode] = useState<ApplyMode>("today");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const entries = history.length
    ? history
    : [{ effectiveFrom: earliestDay, amount: oldValue }];

  const change: PriceChange =
    mode === "date"
      ? { mode: "date", amount: newValue, from }
      : mode === "range"
        ? { mode: "range", amount: newValue, from: from <= to ? from : to, to: from <= to ? to : from }
        : mode === "correct"
          ? { mode: "correct", amount: newValue, today }
          : { mode: "today", amount: newValue, today };

  const rangeIncomplete = mode === "range" && (!from || !to);
  const periods = rangeIncomplete ? [] : toPeriods(applyPriceChange(entries, change));

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="When did this price apply?"
      primaryAction={{
        content: "Save price",
        disabled: rangeIncomplete,
        onAction: () => onConfirm(mode, from, to),
      }}
      secondaryActions={[{ content: "Cancel", onAction: onCancel }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="p">
            <b>{itemName}</b>: {oldValue} → <b>{newValue}</b> {currency}
          </Text>

          <ChoiceList
            title="When"
            titleHidden
            selected={[mode]}
            onChange={(v) => setMode(v[0] as ApplyMode)}
            choices={[
              {
                label: "From today onward",
                value: "today",
                helpText: "The normal one. Orders you already have keep their old price.",
              },
              {
                label: "Starting from an earlier date",
                value: "date",
                helpText: "The price changed a while ago and you are entering it now.",
                renderChildren: (selected) =>
                  selected ? (
                    <Box paddingBlockStart="200">
                      <TextField
                        label="New price starts on"
                        type="date"
                        value={from}
                        max={today}
                        onChange={setFrom}
                        autoComplete="off"
                      />
                    </Box>
                  ) : null,
              },
              {
                label: "Only between two dates",
                value: "range",
                helpText:
                  "It was this price for a while, then went back — a temporary supplier, or a short offer.",
                renderChildren: (selected) =>
                  selected ? (
                    <Box paddingBlockStart="200">
                      <InlineStack gap="300" wrap>
                        <TextField
                          label="From"
                          type="date"
                          value={from}
                          max={today}
                          onChange={setFrom}
                          autoComplete="off"
                        />
                        <TextField
                          label="Until"
                          type="date"
                          value={to}
                          max={today}
                          onChange={setTo}
                          autoComplete="off"
                        />
                      </InlineStack>
                    </Box>
                  ) : null,
              },
              {
                label: "Fix a mistake — it was always this price",
                value: "correct",
                helpText: "The old number was simply wrong.",
              },
            ]}
          />

          <Divider />

          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">
              What your reports will use
            </Text>
            {rangeIncomplete ? (
              <Text as="p" tone="subdued">
                Pick both dates to see the result.
              </Text>
            ) : (
              <BlockStack gap="100">
                {periods.map((p) => {
                  const isNew = p.amount === newValue;
                  return (
                    <InlineStack key={`${p.from}-${p.to ?? "now"}`} align="space-between" blockAlign="center">
                      <Text as="span" tone={isNew ? undefined : "subdued"}>
                        {describePeriod(p, earliestDay)}
                      </Text>
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" fontWeight={isNew ? "bold" : "regular"}>
                          {p.amount} {currency}
                        </Text>
                        {isNew && <Badge tone="success">new</Badge>}
                      </InlineStack>
                    </InlineStack>
                  );
                })}
              </BlockStack>
            )}
          </BlockStack>

          {mode === "correct" && (
            <Banner tone="warning">
              <p>
                Your past reports will change, because they were calculated with a price that was
                wrong. If the price genuinely changed at some point, pick one of the date options
                instead.
              </p>
            </Banner>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
