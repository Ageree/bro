/**
 * A WB or Ozon order number is 13–19 bare digits, which is exactly a card
 * number's shape, so length cannot tell them apart. Luhn can: an order number
 * that happens to pass it is rare, a card number that fails it does not exist.
 */
export function looksLikeCardNumber(value: string) {
  const bare = value.replaceAll(/[\s-]/gu, "");
  if (bare.length < 13 || bare.length > 19) return false;
  let sum = 0;
  for (let index = 0; index < bare.length; index += 1) {
    const digit = Number(bare[bare.length - 1 - index]);
    const doubled = digit * 2;
    sum += index % 2 === 0 ? digit : doubled > 9 ? doubled - 9 : doubled;
  }
  return sum % 10 === 0;
}
