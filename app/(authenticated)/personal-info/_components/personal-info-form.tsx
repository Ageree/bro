"use client";

import { type SubmitEvent, useState } from "react";
import { z } from "zod";
import {
  Document,
  DocumentTitle,
  Flash,
  Section,
  StatusLine,
} from "@web/components/paper/document";
import { Button } from "@web/components/ui/button";
import { Field, FieldLabel } from "@web/components/ui/field";
import { Input } from "@web/components/ui/input";
import {
  defaultTimeZone,
  userProfileSchema,
  type UserProfile,
} from "@shared/user-profile/schema";
import { api } from "@web/trpc/client";

/**
 * Paper, like the cabinet and the vault: a title, fine print, and sections
 * divided by hairlines. A field is a hairline rectangle with its label set
 * small and grey above it; saving is the one inverted rectangle.
 */
export function PersonalInfoForm({
  initialProfile,
}: {
  readonly initialProfile: UserProfile;
}) {
  const updateProfile = api.userProfile.update.useMutation();
  const [status, setStatus] = useState<"error" | "saved">();

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus(undefined);
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const parsed = userProfileSchema.safeParse({
      addressLine1: nullableFormValue(values.addressLine1),
      addressLine2: nullableFormValue(values.addressLine2),
      city: nullableFormValue(values.city),
      countryCode: nullableFormValue(values.countryCode),
      dateOfBirth: nullableFormValue(values.dateOfBirth),
      email: nullableFormValue(values.email),
      firstName: nullableFormValue(values.firstName),
      lastName: nullableFormValue(values.lastName),
      phone: nullableFormValue(values.phone),
      postalCode: nullableFormValue(values.postalCode),
      region: nullableFormValue(values.region),
      timezone: nullableFormValue(values.timezone),
    });
    if (!parsed.success) {
      setStatus("error");
      return;
    }

    updateProfile.mutate(parsed.data, {
      onError: () => {
        setStatus("error");
      },
      onSuccess: () => {
        setStatus("saved");
      },
    });
  };

  return (
    <Document>
      <DocumentTitle>Личные данные</DocumentTitle>
      <p className="type-fine text-muted-foreground">
        Этими данными Bro заполняет формы на сайтах — за тебя и без вопросов.
        Пароли и карты храни в сейфе.
      </p>

      {status === "error" ? (
        <Flash>
          Не сохранилось. Проверь почту, дату рождения, двухбуквенный код страны
          и часовой пояс — и попробуй ещё раз.
        </Flash>
      ) : null}

      <datalist id="personal-info-timezones">
        {suggestedTimeZones.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </datalist>

      <form noValidate onSubmit={submit}>
        <Section headingId="identity-heading" title="Кто ты">
          <ProfileFields>
            <ProfileField
              autoComplete="given-name"
              defaultValue={initialProfile.firstName}
              label="Имя"
              name="firstName"
            />
            <ProfileField
              autoComplete="family-name"
              defaultValue={initialProfile.lastName}
              label="Фамилия"
              name="lastName"
            />
            <ProfileField
              autoComplete="email"
              defaultValue={initialProfile.email}
              label="Почта"
              name="email"
              type="email"
            />
            <ProfileField
              autoComplete="tel"
              defaultValue={initialProfile.phone}
              label="Телефон"
              name="phone"
              type="tel"
            />
            <ProfileField
              autoComplete="bday"
              defaultValue={initialProfile.dateOfBirth}
              label="Дата рождения"
              name="dateOfBirth"
              type="date"
            />
            <ProfileField
              autoComplete="off"
              defaultValue={initialProfile.timezone}
              label="Часовой пояс"
              list="personal-info-timezones"
              name="timezone"
              placeholder={defaultTimeZone}
            />
          </ProfileFields>
        </Section>

        <Section headingId="address-heading" title="Почтовый адрес">
          <ProfileFields>
            <ProfileField
              autoComplete="address-line1"
              className="sm:col-span-2"
              defaultValue={initialProfile.addressLine1}
              label="Адрес, строка 1"
              name="addressLine1"
            />
            <ProfileField
              autoComplete="address-line2"
              className="sm:col-span-2"
              defaultValue={initialProfile.addressLine2}
              label="Адрес, строка 2"
              name="addressLine2"
            />
            <ProfileField
              autoComplete="address-level2"
              defaultValue={initialProfile.city}
              label="Город"
              name="city"
            />
            <ProfileField
              autoComplete="address-level1"
              defaultValue={initialProfile.region}
              label="Область или регион"
              name="region"
            />
            <ProfileField
              autoComplete="postal-code"
              defaultValue={initialProfile.postalCode}
              label="Индекс"
              name="postalCode"
            />
            <ProfileField
              autoComplete="country"
              defaultValue={initialProfile.countryCode}
              label="Код страны"
              maxLength={2}
              name="countryCode"
              placeholder="RU"
            />
          </ProfileFields>
        </Section>

        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Button
            disabled={updateProfile.isPending}
            type="submit"
            variant="paper"
          >
            {updateProfile.isPending ? "Сохраняем…" : "Сохранить"}
          </Button>
          <StatusLine>{status === "saved" ? "Сохранено." : null}</StatusLine>
        </div>
      </form>
    </Document>
  );
}

function ProfileFields({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="mt-[0.9rem] grid gap-[0.9rem] sm:grid-cols-2 sm:gap-x-6">
      {children}
    </div>
  );
}

function ProfileField({
  className,
  defaultValue,
  label,
  name,
  ...inputProps
}: Omit<React.ComponentProps<typeof Input>, "defaultValue" | "id"> & {
  readonly defaultValue: string | null;
  readonly label: string;
  readonly name: keyof UserProfile;
}) {
  const id = `personal-info-${name}`;
  return (
    <Field
      className={className ? `gap-[0.35rem] ${className}` : "gap-[0.35rem]"}
    >
      <FieldLabel
        className="type-field-label text-muted-foreground"
        htmlFor={id}
      >
        {label}
      </FieldLabel>
      <Input
        defaultValue={defaultValue ?? ""}
        id={id}
        name={name}
        variant="paper"
        {...inputProps}
      />
    </Field>
  );
}

/**
 * The zones this product's people actually live in, offered as a datalist so
 * the field stays a plain text input that accepts any valid IANA name.
 */
const suggestedTimeZones = [
  "Europe/Kaliningrad",
  "Europe/Moscow",
  "Europe/Samara",
  "Asia/Yekaterinburg",
  "Asia/Omsk",
  "Asia/Novosibirsk",
  "Asia/Krasnoyarsk",
  "Asia/Irkutsk",
  "Asia/Yakutsk",
  "Asia/Vladivostok",
  "Asia/Magadan",
  "Asia/Kamchatka",
  "Europe/Minsk",
  "Asia/Tbilisi",
  "Asia/Yerevan",
  "Asia/Almaty",
  "Asia/Tashkent",
];

function nullableFormValue(value: FormDataEntryValue | undefined) {
  const parsed = z.string().trim().min(1).safeParse(value);
  return parsed.success ? parsed.data : null;
}
