const E164_PHONE_NUMBER = /^\+[1-9]\d{7,14}$/;
const PHONE_NUMBER_INPUT = /^\+?[\d\s().-]+$/;

export function isE164PhoneNumber(value: string) {
  return E164_PHONE_NUMBER.test(value);
}

export function normalizeAuthPhoneNumber(value: string) {
  const trimmedValue = value.trim();
  if (!PHONE_NUMBER_INPUT.test(trimmedValue)) return undefined;

  const digits = trimmedValue.replace(/\D/g, "");
  const normalizedValue = trimmedValue.startsWith("+")
    ? `+${digits}`
    : withoutCountryCode(digits);

  return isE164PhoneNumber(normalizedValue) ? normalizedValue : undefined;
}

/**
 * A number typed without «+», as people in Russia write it: «8 999 …» and
 * «7 999 …» are +7, and so is a ten-digit «999 …», since a Russian mobile
 * starts with 9. The placeholder asks for +7; before this, «8 999 …» became
 * +1 899… and the code went to no one. Other ten digits stay American, as a
 * US number is typed: «(202) 555-0123».
 */
function withoutCountryCode(digits: string) {
  if (
    digits.length === 11 &&
    (digits.startsWith("8") || digits.startsWith("7"))
  )
    return `+7${digits.slice(1)}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10 && digits.startsWith("9")) return `+7${digits}`;
  return `+1${digits}`;
}
