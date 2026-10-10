// Reading an uncontrolled form on submit. Blank optional fields come back
// undefined, because the API rejects empty strings where it expects a value.

const el = (form: HTMLFormElement, name: string) => form.elements.namedItem(name) as HTMLInputElement | null;

export const str = (form: HTMLFormElement, name: string) => el(form, name)?.value.trim() ?? "";
export const opt = (form: HTMLFormElement, name: string) => str(form, name) || undefined;
export const num = (form: HTMLFormElement, name: string) => (str(form, name) === "" ? undefined : Number(str(form, name)));
export const nums = (form: HTMLFormElement, name: string) => str(form, name).split(/[,\s]+/).filter(Boolean).map(Number);
export const ticked = (form: HTMLFormElement, name: string) => Boolean(el(form, name)?.checked);
