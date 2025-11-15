const LANGUAGES = {
  en: {
    name: 'English',
    flag: '/img/flags/en.png'
  },
  cn: {
    name: '中文',
    flag: '/img/flags/cn.png'
  },
  kr: {
    name: '한국어',
    flag: '/img/flags/kr.png'
  }
};

function createLanguageSelector() {
  const langDiv = document.createElement('div');
  langDiv.className = 'language';
  langDiv.onclick = (e) => toggleLanguage(e);

  const currentLang = document.createElement('span');
  currentLang.id = 'currentLang';
  
  const dropdown = document.createElement('div');
  dropdown.className = 'language-dropdown';
  dropdown.id = 'langDropdown';

  // Create language options
  Object.entries(LANGUAGES).forEach(([code, lang]) => {
    const option = document.createElement('a');
    option.href = '#';
    option.className = 'lang-option';
    option.onclick = (e) => selectLanguage(code, e);
    
    const flag = document.createElement('img');
    flag.src = lang.flag;
    flag.alt = lang.name;
    
    option.appendChild(flag);
    option.appendChild(document.createTextNode(lang.name));
    dropdown.appendChild(option);
  });

  langDiv.appendChild(currentLang);
  langDiv.appendChild(dropdown);
  return langDiv;
}

function initLanguageSelector() {
  // Add language styles
  if (!document.getElementById('langStyles')) {
    const style = document.createElement('style');
    style.id = 'langStyles';
    style.textContent = `
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px;
        background: #0f0f0f;
        position: sticky;
        top: 0;
        z-index: 100;
      }
      .language {
        position: relative;
        cursor: pointer;
        padding: 8px;
      }
      .language-dropdown {
        display: none;
        position: absolute;
        top: 100%;
        right: 0;
        background: #1a1a1a;
        border: 1px solid #333;
        border-radius: 8px;
        overflow: hidden;
        width: 160px;
        z-index: 1000;
        box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      }
      .language-dropdown.show {
        display: block;
        animation: fadeIn 0.2s ease;
      }
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(-10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .lang-option {
        padding: 12px 16px;
        display: flex;
        align-items: center;
        gap: 8px;
        color: #fff;
        text-decoration: none;
      }
      .lang-option:hover {
        background: #252525;
      }
      .lang-option.selected {
        background: #333;
      }
      .lang-option img {
        width: 20px;
        height: 20px;
        border-radius: 50%;
      }
    `;
    document.head.appendChild(style);
  }

  // Find or create header
  let header = document.querySelector('.header');
  if (!header) {
    header = document.createElement('header');
    header.className = 'header';
    document.body.insertBefore(header, document.body.firstChild);
  }

  // Add language selector to header if not already present
  if (!header.querySelector('.language')) {
    const langSelector = createLanguageSelector();
    header.appendChild(langSelector);
  }

  // Load saved language
  const savedLang = localStorage.getItem('preferredLanguage') || 'en';
  const currentLangEl = document.getElementById('currentLang');
  if (currentLangEl) {
    currentLangEl.textContent = LANGUAGES[savedLang].name + ' 🌐';
  }

  // Update selected state
  document.querySelectorAll('.lang-option').forEach(opt => {
    opt.classList.remove('selected');
    if (opt.textContent.includes(LANGUAGES[savedLang].name)) {
      opt.classList.add('selected');
    }
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.language')) {
      document.getElementById('langDropdown')?.classList.remove('show');
    }
  });
}

function toggleLanguage(e) {
  e.stopPropagation();
  const dropdown = document.getElementById('langDropdown');
  dropdown.classList.toggle('show');
}

function selectLanguage(lang, e) {
  e.preventDefault();
  e.stopPropagation();
  
  const langData = LANGUAGES[lang];
  document.getElementById('currentLang').textContent = langData.name + ' 🌐';
  
  document.querySelectorAll('.lang-option').forEach(opt => {
    opt.classList.remove('selected');
  });
  e.currentTarget.classList.add('selected');
  
  localStorage.setItem('preferredLanguage', lang);
  document.getElementById('langDropdown').classList.remove('show');
}

document.addEventListener('DOMContentLoaded', initLanguageSelector);