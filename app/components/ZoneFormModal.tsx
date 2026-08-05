import { Modal, BlockStack, TextField, Checkbox, Text } from "@shopify/polaris";
import { PriceRowsEditor } from "./PriceRowsEditor";
import type { PriceEditorModel } from "../lib/priceTimeline";

export type ZoneDraft = {
  id: string | null;
  name: string;
  keywords: string;
  isDefault: boolean;
  price: PriceEditorModel;
};

/**
 * Add or edit a delivery zone, including everything the courier has charged for
 * it over time. Same shape as the material form so a cost is edited the same
 * way wherever it lives.
 */
export function ZoneFormModal({
  draft,
  currency,
  today,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: ZoneDraft;
  currency: string;
  today: string;
  busy: boolean;
  onChange: (next: ZoneDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const isEdit = draft.id !== null;
  const badPeriod = draft.price.periods.some((p) => p.from && p.to && p.from > p.to);

  return (
    <Modal
      open
      onClose={onCancel}
      title={isEdit ? `Edit ${draft.name || "zone"}` : "Add a delivery zone"}
      primaryAction={{
        content: isEdit ? "Save changes" : "Add zone",
        onAction: onSave,
        loading: busy,
        disabled: !draft.name.trim() || badPeriod,
      }}
      secondaryActions={[{ content: "Cancel", onAction: onCancel }]}
    >
      <Modal.Section>
        <BlockStack gap="400">
          <TextField
            label="Zone name"
            value={draft.name}
            onChange={(v) => onChange({ ...draft, name: v })}
            autoComplete="off"
            placeholder="e.g. Cairo"
            helpText="Use the same name as your Shopify shipping zone where possible."
            autoFocus={!isEdit}
          />

          <TextField
            label="Also match these words (optional)"
            value={draft.keywords}
            onChange={(v) => onChange({ ...draft, keywords: v })}
            autoComplete="off"
            placeholder="nasr city, heliopolis, مصر الجديدة"
            helpText="Separate with commas. Used to match an order's city or governorate."
          />

          <PriceRowsEditor
            label="Real courier cost"
            helpText="What the courier actually charges you today for this zone."
            model={draft.price}
            onChange={(price) => onChange({ ...draft, price })}
            currency={currency}
            today={today}
          />

          <Checkbox
            label="Use this zone when no other one matches"
            checked={draft.isDefault}
            onChange={(v) => onChange({ ...draft, isDefault: v })}
          />

          {isEdit && (
            <Text as="p" tone="subdued" variant="bodySm">
              Orders in an earlier period use that period&apos;s cost, so your past reports stay
              correct.
            </Text>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
