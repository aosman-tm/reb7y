import { Select } from "@shopify/polaris";
import { useSearchParams } from "@remix-run/react";
import { RANGE_PRESETS } from "../lib/dates";

/** Date-range dropdown that syncs the chosen preset into the `range` URL param. */
export function RangeSelector({ value }: { value: string }) {
  const [params, setParams] = useSearchParams();
  return (
    <Select
      label="Date range"
      labelHidden
      options={RANGE_PRESETS}
      value={value}
      onChange={(v) => {
        const next = new URLSearchParams(params);
        next.set("range", v);
        setParams(next, { replace: true });
      }}
    />
  );
}
