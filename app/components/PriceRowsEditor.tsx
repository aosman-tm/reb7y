import {
  BlockStack,
  InlineStack,
  TextField,
  Button,
  Text,
  Box,
  Card,
} from "@shopify/polaris";
import type { PriceEditorModel, PriceRow } from "../lib/priceTimeline";

/**
 * Edits one cost: what it is now, plus any earlier periods where it differed.
 *
 * Shared by materials, delivery zones and product costs so a price is edited
 * the same way everywhere.
 *
 * The current amount is the baseline and covers every date no period claims, so
 * a merchant whose price never changed only ever sees a single number. Periods
 * are something you add on purpose — "the box cost 20 EGP for two weeks in
 * August, then went back".
 */
export function PriceRowsEditor({
  label,
  helpText,
  model,
  onChange,
  currency,
  today,
  autoFocus,
}: {
  label: string;
  helpText?: string;
  model: PriceEditorModel;
  onChange: (next: PriceEditorModel) => void;
  currency: string;
  today: string;
  autoFocus?: boolean;
}) {
  const setCurrent = (value: string) =>
    onChange({ ...model, current: parseFloat(value || "0") || 0 });

  const setPeriod = (index: number, patch: Partial<PriceRow>) =>
    onChange({
      ...model,
      periods: model.periods.map((p, i) => (i === index ? { ...p, ...patch } : p)),
    });

  const addPeriod = () =>
    onChange({
      ...model,
      periods: [...model.periods, { from: today, to: today, amount: model.current }],
    });

  const removePeriod = (index: number) =>
    onChange({ ...model, periods: model.periods.filter((_, i) => i !== index) });

  return (
    <BlockStack gap="300">
      <TextField
        label={label}
        type="number"
        value={String(model.current)}
        onChange={setCurrent}
        autoComplete="off"
        prefix={currency}
        min={0}
        step={0.01}
        helpText={helpText ?? "What it costs today."}
        autoFocus={autoFocus}
      />

      {model.periods.length > 0 && (
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">
            Earlier prices
          </Text>
          {model.periods.map((period, i) => (
            <Card key={i} background="bg-surface-secondary">
              <BlockStack gap="200">
                <InlineStack gap="300" wrap blockAlign="end">
                  <TextField
                    label="From"
                    type="date"
                    value={period.from}
                    max={today}
                    onChange={(v) => setPeriod(i, { from: v })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Until"
                    type="date"
                    value={period.to ?? ""}
                    max={today}
                    onChange={(v) => setPeriod(i, { to: v || null })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Price then"
                    type="number"
                    value={String(period.amount)}
                    onChange={(v) => setPeriod(i, { amount: parseFloat(v || "0") || 0 })}
                    autoComplete="off"
                    prefix={currency}
                    min={0}
                    step={0.01}
                  />
                  <Box paddingBlockEnd="100">
                    <Button
                      variant="plain"
                      tone="critical"
                      onClick={() => removePeriod(i)}
                      accessibilityLabel={`Remove earlier price ${i + 1}`}
                    >
                      Remove
                    </Button>
                  </Box>
                </InlineStack>
                {period.from && period.to && period.from > period.to && (
                  <Text as="p" tone="critical" variant="bodySm">
                    The &quot;from&quot; date is after the &quot;until&quot; date.
                  </Text>
                )}
              </BlockStack>
            </Card>
          ))}
        </BlockStack>
      )}

      <Box>
        <Button variant="plain" onClick={addPeriod}>
          + Add a price for an earlier period
        </Button>
      </Box>

      {model.periods.length === 0 && (
        <Text as="p" tone="subdued" variant="bodySm">
          Only add a period if this cost was different for a while in the past — orders from those
          dates will use that price instead.
        </Text>
      )}
    </BlockStack>
  );
}
