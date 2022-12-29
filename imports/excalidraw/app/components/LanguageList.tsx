import { useAtom } from 'jotai'
import React from 'react'
import { langCodeAtom } from '../ExcalidrawApp'
import * as i18n from '/imports/i18n'
import { languages } from '/imports/i18n'

export const LanguageList = ({ style }: { style?: React.CSSProperties }) => {
  const [langCode, setLangCode] = useAtom(langCodeAtom)

  return (
    <>
      <select
        className='dropdown-select dropdown-select__language'
        onChange={({ target }) => setLangCode(target.value)}
        value={langCode}
        aria-label={i18n.t('buttons.selectLanguage')}
        style={style}
      >
        <option key={i18n.defaultLang.code} value={i18n.defaultLang.code}>
          {i18n.defaultLang.label}
        </option>
        {languages.map(lang => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>
    </>
  )
}
