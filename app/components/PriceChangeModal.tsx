import { useState } from "react";
import { Modal, BlockStack, ChoiceList, TextField, Text, Banner } from "@shopify/polaris";

/** Mirrors ApplyMode in app/lib/costHistory.server.ts — kept local so this
 *  client component never imports a .server module. */
export type ApplyMode = "today" | "date" | "correct";

/**
 * Asks when a cost change should start counting.
 *
 * Without this the merchant cannot tell the difference between "the supplier
 * raised the price" and "I typed the wrong number", and both would rewrite the
 * profit of every past order. Shown only when the amount actually changed.
 */
export function PriceChangeModal({
  open,
  itemName,
  oldValue,
  newValue,
  currency,
  today,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  itemName: string;
  oldValue: number;
  newValue: number;
  currency: string;
  today: string;
  onCancel: () => void;
  onConfirm: (mode: ApplyMode, day: string) => void;
}) {
  const [mode, setMode] = useState<ApplyMode>("today");
  const [day, setDay] = useState(today);

  const wentUp = newValue > oldValue;

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={`Change ${itemName} from ${oldValue} to ${newValue} ${currency}`}
      primaryAction={{
        content: "Save price",
        onAction: () => onConfirm(mode, mode === "date" ? day : today),
      }}
      secondaryActions={[{ content: "Cancel", onAction: onCancel }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <Text as="p" tone="subdued">
            The price {wentUp ? "went up" : "went down"}. When did that start? This decides which
            of your past orders and reports use the new number.
          </Text>

          <ChoiceList
            title="Apply the new price"
            titleHidden
            selected={[mode]}
            onChange={(v) => setMode(v[0] as ApplyMode)}
            choices={[
              {
                label: "From today onward",
                value: "today",
                helpText:
                  "Normal price change. All your old orders and finished reports stay exactly as they are.",
              },
              {
                label: "From a date I choose",
                value: "date",
                helpText:
                  "The price really changed earlier and you are entering it late. Orders from that date onward use the new price.",
                renderChildren: (selected) =>
                  selected ? (
                    <TextField
                      label="New price starts on"
                      type="date"
                      value={day}
                      max={today}
                      onChange={setDay}
                      autoComplete="off"
                    />
                  ) : null,
              },
              {
                label: "Fix a mistake — it was always this price",
                value: "correct",
                helpText:
                  "The old number was simply wrong. Corrects it everywhere, so past reports will change.",
              },
            ]}
          />

          {mode === "correct" && (
            <Banner tone="warning">
              <p>
                Your past reports and profit numbers will change, because they were calculated with
                a price that was wrong. Choose one of the options above instead if the price genuinely
                changed at some point.
              </p>
            </Banner>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
