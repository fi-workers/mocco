// The public help site's own words (the search box and results, "Was this helpful?"), in
// each language a site can be offered in. Articles are the customer's; these are Mocco's.

export interface HelpSiteWords {
  search: string;
  searchPlaceholder: string;
  noResults: string;
  resultsFor: (query: string) => string;
  wasHelpful: string;
  yes: string;
  no: string;
  thanks: string;
}

const ENGLISH: HelpSiteWords = {
  search: 'Search',
  searchPlaceholder: 'Search help',
  noResults: 'No articles match.',
  resultsFor: q => `Results for “${q}”`,
  wasHelpful: 'Was this article helpful?',
  yes: 'Yes',
  no: 'No',
  thanks: 'Thanks for letting us know.',
};

const WORDS: Record<string, HelpSiteWords> = {
  en: ENGLISH,
  ko: {
    search: '검색',
    searchPlaceholder: '도움말 검색',
    noResults: '맞는 문서가 없어요.',
    resultsFor: q => `“${q}” 검색 결과`,
    wasHelpful: '이 문서가 도움이 되었나요?',
    yes: '네',
    no: '아니요',
    thanks: '알려 주셔서 고마워요.',
  },
  ja: {
    search: '検索',
    searchPlaceholder: 'ヘルプを検索',
    noResults: '一致する記事はありません。',
    resultsFor: q => `「${q}」の検索結果`,
    wasHelpful: 'この記事は役に立ちましたか？',
    yes: 'はい',
    no: 'いいえ',
    thanks: 'ご回答ありがとうございます。',
  },
  zh: {
    search: '搜索',
    searchPlaceholder: '搜索帮助',
    noResults: '没有匹配的文章。',
    resultsFor: q => `“${q}”的搜索结果`,
    wasHelpful: '这篇文章有帮助吗？',
    yes: '是',
    no: '否',
    thanks: '感谢您的反馈。',
  },
  th: {
    search: 'ค้นหา',
    searchPlaceholder: 'ค้นหาความช่วยเหลือ',
    noResults: 'ไม่พบบทความที่ตรงกัน',
    resultsFor: q => `ผลการค้นหา “${q}”`,
    wasHelpful: 'บทความนี้มีประโยชน์ไหม',
    yes: 'ใช่',
    no: 'ไม่',
    thanks: 'ขอบคุณสำหรับความคิดเห็น',
  },
  vi: {
    search: 'Tìm kiếm',
    searchPlaceholder: 'Tìm trợ giúp',
    noResults: 'Không có bài viết phù hợp.',
    resultsFor: q => `Kết quả cho “${q}”`,
    wasHelpful: 'Bài viết này có hữu ích không?',
    yes: 'Có',
    no: 'Không',
    thanks: 'Cảm ơn bạn đã cho chúng tôi biết.',
  },
  id: {
    search: 'Cari',
    searchPlaceholder: 'Cari bantuan',
    noResults: 'Tidak ada artikel yang cocok.',
    resultsFor: q => `Hasil untuk “${q}”`,
    wasHelpful: 'Apakah artikel ini membantu?',
    yes: 'Ya',
    no: 'Tidak',
    thanks: 'Terima kasih atas masukannya.',
  },
  es: {
    search: 'Buscar',
    searchPlaceholder: 'Buscar en la ayuda',
    noResults: 'Ningún artículo coincide.',
    resultsFor: q => `Resultados de «${q}»`,
    wasHelpful: '¿Te ha resultado útil este artículo?',
    yes: 'Sí',
    no: 'No',
    thanks: 'Gracias por contárnoslo.',
  },
  pt: {
    search: 'Pesquisar',
    searchPlaceholder: 'Pesquisar na ajuda',
    noResults: 'Nenhum artigo corresponde.',
    resultsFor: q => `Resultados para “${q}”`,
    wasHelpful: 'Este artigo foi útil?',
    yes: 'Sim',
    no: 'Não',
    thanks: 'Obrigado pelo retorno.',
  },
  fr: {
    search: 'Rechercher',
    searchPlaceholder: "Rechercher dans l'aide",
    noResults: 'Aucun article ne correspond.',
    resultsFor: q => `Résultats pour « ${q} »`,
    wasHelpful: 'Cet article vous a-t-il été utile ?',
    yes: 'Oui',
    no: 'Non',
    thanks: 'Merci de nous l’avoir dit.',
  },
  de: {
    search: 'Suchen',
    searchPlaceholder: 'Hilfe durchsuchen',
    noResults: 'Keine passenden Artikel.',
    resultsFor: q => `Ergebnisse für „${q}“`,
    wasHelpful: 'War dieser Artikel hilfreich?',
    yes: 'Ja',
    no: 'Nein',
    thanks: 'Danke für Ihre Rückmeldung.',
  },
  it: {
    search: 'Cerca',
    searchPlaceholder: 'Cerca nella guida',
    noResults: 'Nessun articolo corrisponde.',
    resultsFor: q => `Risultati per «${q}»`,
    wasHelpful: 'Questo articolo ti è stato utile?',
    yes: 'Sì',
    no: 'No',
    thanks: 'Grazie per avercelo detto.',
  },
};

export const wordsFor = (locale: string): HelpSiteWords => WORDS[locale] ?? ENGLISH;
