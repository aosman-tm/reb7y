import { Modal, BlockStack, InlineStack, TextField, Select, Text } from "@shopify/polaris";
import { PriceRowsEditor } from "./PriceRowsEditor";
import type { PriceEditorModel } from "../lib/priceTimeline";

export type MaterialDraft = {
  id: string | null;
  name: string;
  unit: string;
  stock: string;
  price: PriceEditorModel;
};

/**
 * Add or edit a material in one place.
 *
 * The price lives here rather than in the table so its full history is visible
 * while editing, and the table can stay simple: it shows only what a material
 * costs today.
 */
export function MaterialFormModal({
  draft,
  units,
  currency,
  today,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: MaterialDraft;
  units: string[];
  currency: string;
  today: string;
  busy: boolean;
  onChange: (next: MaterialDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const isEdit = draft.id !== null;
  const unitOptions = units.map((u) => ({ label: u, value: u }));
  if (!units.includes(draft.unit)) unitOptions.unshift({ label: draft.unit, value: draft.unit });

  const badPeriod = draft.price.periods.some((p) => p.from && p.to && p.from > p.to);

  return (
    <Modal
      open
      onClose={onCancel}
      title={isEdit ? `Edit ${draft.name || "material"}` : "Add a material"}
      primaryAction={{
        content: isEdit ? "Save changes" : "Add material",
        onAction: onSave,
        loading: busy,
        disabled: !draft.name.trim() || badPeriod,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onCancel }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <InlineStack gap="300" wrap blockAlign="start">
            <TextField
              label="Name"
              value={draft.name}
              onChange={(v) => onChange({ ...draft, name: v })}
              autoComplete="off"
              placeholder="e.g. Small box"
              autoFocus={!isEdit}
            />
            <Select
              label="Unit"
              options={unitOptions}
              value={draft.unit}
              onChange={(v) => onChange({ ...draft, unit: v })}
            />
            {!isEdit && (
              <TextField
                label="Starting stock"
                type="number"
                value={draft.stock}
                onChange={(v) => onChange({ ...draft, stock: v })}
                autoComplete="off"
                min={0}
                step={1}
                placeholder="0"
                helpText="How many you have now."
              />
            )}
          </InlineStack>

          <PriceRowsEditor
            label={`Cost per ${draft.unit || "unit"}`}
            model={draft.price}
            onChange={(price) => onChange({ ...draft, price })}
            currency={currency}
            today={today}
          />

          {isEdit && (
            <Text as="p" tone="subdued" variant="bodySm">
              Changing the cost above affects orders from today onward. Orders in an earlier period
              use that period&apos;s price, so your past reports stay correct.
            </Text>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
