/**
 * Government and utility sites: where a person's fines, taxes, documents,
 * meter readings and bills actually live, and which of these sites let a
 * person in with their Госуслуги (ESIA) account.
 */

/** The registrable domain of Госуслуги, where the ESIA sign-in page lives. */
export const gosuslugiDomain = "gosuslugi.ru";

/**
 * Sites that sign a person in through Госуслуги («Войти через Госуслуги»),
 * so the Госуслуги login in the vault opens them too: mos.ru and ЕМИАС, the
 * tax service's personal account, Мосэнергосбыт, the Social Fund, Росреестр,
 * ФССП, the Moscow region's portal and the St Petersburg health portal. The
 * list is closed on purpose: signing in through Госуслуги hands the site the
 * person's Госуслуги profile, so it is for public services only, never for a
 * shop or a bank that happens to offer the button (RU 24.09, d07: the errand
 * stopped at mos.ru's sign-in with the Госуслуги login saved).
 */
const esiaSignInDomains = [
  "emias.info",
  "fssp.gov.ru",
  "gorzdrav.spb.ru",
  "mos.ru",
  "mosenergosbyt.ru",
  "mosreg.ru",
  "nalog.gov.ru",
  "nalog.ru",
  "rosreestr.gov.ru",
  "sfr.gov.ru",
];

/** Whether a bare lower-case host is under one of `domains`. */
function under(host: string, domains: readonly string[]) {
  return domains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`)
  );
}

/** Whether a site lets its visitors in with their Госуслуги account. */
export function signsInWithGosuslugi(host: string) {
  return under(host, esiaSignInDomains);
}

/** Whether a host is Госуслуги itself, where its login is the site's own. */
export function isGosuslugi(host: string) {
  return under(host, [gosuslugiDomain]);
}

/** The bare lower-case host of a site origin, without `www.`. */
function siteHost(site: string | undefined) {
  const host = site === undefined ? undefined : URL.parse(site)?.hostname;
  const bare = host?.toLowerCase().replace(/^www\./u, "");
  return bare === undefined || bare === "" ? undefined : bare;
}

/**
 * Where a run may sign in through Госуслуги, and what it does on the screen
 * that hands a site the person's profile. Binding the login only to the
 * closed list is not enough on its own: once bound, the login can be typed
 * on esia.gosuslugi.ru whichever site sent the run there, and the browser
 * profile may already hold a live Госуслуги session from an earlier errand.
 * So every run hears that the Госуслуги way in is for the errand's own
 * public-service site only, and that the access screen for anyone else — a
 * fines aggregator, a bank, a private clinic on a fallback — or for anyone
 * at all on an errand the person has not confirmed, is where it stops.
 */
export function gosuslugiSignInRule(
  site: string | undefined,
  confirmed: boolean
) {
  const host = siteHost(site);
  const ownSite =
    host !== undefined && signsInWithGosuslugi(host) && !isGosuslugi(host)
      ? host
      : undefined;
  const where =
    host !== undefined && isGosuslugi(host)
      ? "Sign in through Госуслуги only to gosuslugi.ru itself."
      : ownSite === undefined
        ? "Do not sign in to any site through Госуслуги («Войти через Госуслуги», ЕСИА) on this errand."
        : `Sign in through Госуслуги («Войти через Госуслуги», ЕСИА) only to gosuslugi.ru and to this errand's own site, ${ownSite}.`;
  const access =
    confirmed && ownSite !== undefined
      ? `If Госуслуги shows a screen asking to give an organisation access to the person's data («Предоставление прав доступа», «Разрешить доступ», «Предоставить права»), confirm it only when that organisation is ${ownSite} itself; for any other organisation do not confirm it: stop there with NEEDS: decision and name in DETAILS the organisation and the data it asks for.`
      : "If Госуслуги shows a screen asking to give an organisation access to the person's data («Предоставление прав доступа», «Разрешить доступ», «Предоставить права»), do not confirm it: stop there with NEEDS: decision and name in DETAILS the organisation and the data it asks for.";
  return [
    where,
    "Never use Госуслуги to sign in on a fallback or any other site that offers that button — a shop, a bank, a private clinic, an aggregator, a fines checker: signing in there hands it the person's Госуслуги profile.",
    access,
  ].join(" ");
}

const chargesPattern =
  /(?<!\p{L})(?:штраф\p{L}*|налог\p{L}*|пошлин\p{L}*|задолженност\p{L}*|начислени\p{L}*|недоимк\p{L}*|долг(?:и|ов|а)?|fines?|tax(?:es)?)(?!\p{L})/iu;

const documentsPattern =
  /(?<!\p{L})(?:паспорт\p{L}*|загран\p{L}*|водительск\p{L}*|полис\p{L}*|снилс\p{L}*|документ\p{L}*|passports?)(?!\p{L})/iu;

const utilitiesPattern =
  /(?<!\p{L})(?:показани\p{L}*|сч[её]тчик\p{L}*|квитанц\p{L}*|жкх|жку|епд|коммунал\p{L}*|коммуналк\p{L}*|квартплат\p{L}*|электроэнерги\p{L}*|мосэнергосбыт\p{L}*|водоснабжени\p{L}*|meter\s+readings?|utility\s+bills?)(?!\p{L})/iu;

const doctorPattern =
  /(?<!\p{L})(?:врач\p{L}*|терапевт\p{L}*|поликлиник\p{L}*|емиас\p{L}*|доктор\p{L}*|педиатр\p{L}*|стоматолог\p{L}*|окулист\p{L}*|офтальмолог\p{L}*|гинеколог\p{L}*|невролог\p{L}*|лор|doctors?|clinics?)(?!\p{L})/iu;

/**
 * Fines and taxes: where they are, and that each is read, not counted.
 * «Штрафов нет, но висит 500 ₽ к оплате» said nothing about the 500 ₽.
 */
const chargesHint =
  "Fines, taxes and other charges: on Госуслуги they are under «Платежи» (fines, taxes, duties, court debts); the tax service's personal account (lkfl2.nalog.ru) has the taxes too when it is this errand's own site. Open every charge you find and read what it is for before you report it; list each in CHARGES with the discount and its deadline exactly as the decree states them, and say plainly when there are none.";

const documentsHint =
  "Documents: the person's own documents — passports, the driving licence, the OMS policy, СНИЛС — are in their Госуслуги profile («Документы и данные»). For each one the errand asks about, report its kind and the date it expires; never copy its number.";

/**
 * Meter readings and bills: who takes which reading, and that passing them is
 * a submission staged like any other. RU d08 ended with the readings never
 * passed and the bill never looked for.
 */
const utilitiesHint =
  "Meter readings and utility bills: in Moscow water readings go to mos.ru, electricity to Мосэнергосбыт (my.mosenergosbyt.ru), and the monthly bill (ЕПД) is on mos.ru and in ГИС ЖКХ (dom.gosuslugi.ru); elsewhere look in the regional billing centre (ЕИРЦ) or the supplier's own personal account, and in ГИС ЖКХ. For readings, match each meter on the page by its serial number, not by its position; type in the new readings the errand gives, whole units only unless the form asks for decimals; report one ITEMS line per meter — the meter and its serial number in name, the new reading in quantity, the previous reading with its date and the difference in details. Passing the readings is a submission in the person's name, so it follows the rules on acting in their name below: without their confirmation, stop before the button that passes them with NEEDS: decision. When the page does not take readings today, give the window it states in NEXT. For a bill, report the month, the amount and the due date in CHARGES.";

const doctorHint =
  "Doctor's appointments: in Moscow through ЕМИАС (emias.info, or mos.ru — sign-in through mos.ru or Госуслуги); elsewhere through Госуслуги («Запись к врачу») or the region's own health portal; under a voluntary insurance (ДМС) through the clinic's own site. For the slot you pick, report the doctor and their speciality, the date and time, the clinic's address and the room, what to bring as the site says (the OMS policy, a passport, a referral) and how to cancel or move it, in BOOKING.";

/**
 * Where the public-service facts of an errand live, for the topics it names.
 * Undefined for an errand about none of them.
 */
export function publicServiceLine(errand: string) {
  const hints = [
    chargesPattern.test(errand) ? chargesHint : undefined,
    documentsPattern.test(errand) ? documentsHint : undefined,
    utilitiesPattern.test(errand) ? utilitiesHint : undefined,
    doctorPattern.test(errand) ? doctorHint : undefined,
  ].filter((hint) => hint !== undefined);
  return hints.length === 0 ? undefined : hints.join("\n");
}
