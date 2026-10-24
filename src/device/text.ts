// Homey-free text helper. `homey.__` does not fill `{name}` tokens of our locale strings (the pairing view replaces its
// own by hand), so texts with variables are completed here.

/** Replaces every `{name}` in `text` by `vars[name]`. A token without a value is left as it is. */
export function fillPlaceholders(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (token, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : token,
  );
}
