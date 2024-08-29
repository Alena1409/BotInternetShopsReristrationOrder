const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const path = require('path');
require('dotenv').config();
const fs = require('fs');
const axios = require('axios');

const token = process.env.KEY;
const spreadsheetId = process.env.SPREADSHEET_ID;
const photoDir = path.join(__dirname, 'photos');

// Проверка наличия необходимых переменных окружения
if (!token || !spreadsheetId) {
  console.error('Ошибка: Не заданы необходимые переменные окружения!');
  process.exit(1);
}

// Инициализация бота
const bot = new TelegramBot(token, {
  polling: {
    interval: 300,
    autoStart: true
  }
});

// Создание директории для фото, если ее нет
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir);

// Инициализация Google API
async function authenticateGoogle() {
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: path.join(__dirname, 'credentials.json'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();
    google.options({ auth: client });
  } catch (error) {
    console.error('Ошибка аутентификации Google:', error);
    throw error;
  }
}

// Описание возможных вопросов и их типов
const questionFlow = [
  {
    question: "Выбор ПВЗ", type: "choice", options: [
      [{ text: 'OZON Владикавказ, ул. Павлика Морозова, 49', callback_data: 'morozov49' }],
      [{ text: 'WB Владикавказ, ул. Тельмана, 37', callback_data: 'telman37' }],
      [{ text: 'OZON, WB Владикавказ, улица Вахтангова, 1', callback_data: 'vakhtangov1' }],
      [{ text: 'СДЭК Владикавказ, пр-к Коста, 79', callback_data: 'costa79' }],
      [{ text: 'СДЭК Владикавказ, Астана Кесаева улица, 11', callback_data: 'kesaeva11' }]
    ]
  },
  { question: "Город получателя", type: "text" },
  { question: "Какой Интернет магазин", type: "text" },
  { question: "ФИО получателя", type: "text" },
  { question: "Телефон получателя", type: "text" },
  { question: "Адрес получения", type: "text" },
  { question: "Перечень товаров(одним сообщением)", type: "text" },
  { question: "Прикрепите фото или код", type: "photo" }
];

const STATE_WAITING = 'waiting';
const STATE_CONFIRMATION = 'confirmation';

// Хранилище данных пользователей
let userData = {};

// Функция отправки сообщения
const sendQuestion = async (chatId, question, options) => {
  await bot.sendMessage(chatId, question, options);
};

// Функция обработки фотографий
const handlePhoto = async (chatId, photo) => {
  try {
    const fileId = photo[photo.length - 1].file_id;
    const fileUrl = await bot.getFileLink(fileId);


    const filePath = path.join(photoDir, `photo_${chatId}.jpg`);

    const response = await axios({
      url: fileUrl,
      responseType: 'stream',
    });
    response.data.pipe(fs.createWriteStream(filePath));

    return new Promise((resolve, reject) => {
      response.data.on('end', () => resolve(filePath));
      response.data.on('error', reject);
    });
  } catch (error) {
    console.error('Ошибка при получении фото:', error);
    await bot.sendMessage(chatId, 'Не удалось получить ваше фото. Пожалуйста, попробуйте снова.');
    throw error;
  }
};

// Функция завершения опроса
const finishSurvey = async (chatId) => {
  const user = userData[chatId];
  if (user.currentQuestionIndex < questionFlow.length - 1) {
    user.currentQuestionIndex++;
    await askNextQuestion(chatId);
  } else {
    user.state = STATE_CONFIRMATION;
    const userResponses = user.responses.map((response, index) => {
      return index === questionFlow.length - 1
        ? `${questionFlow[index].question}: добавлено...`
        : `${questionFlow[index].question}: ${response}`;
    }).join('\n');
    await sendQuestion(chatId, `Ваши данные:\n\n${userResponses}\n\nПодтвердите, если данные верны. Введите "Да" или "Нет".`);
  }
};

// Функция сброса данных пользователя
const resetUser = (chatId) => {
  userData[chatId] = { state: STATE_WAITING, responses: [], photoUrl: null, currentQuestionIndex: 0 };
};

// Функция отправки следующего вопроса
const askNextQuestion = async (chatId) => {
  const user = userData[chatId];
  const currentQuestion = questionFlow[user.currentQuestionIndex];

  let options;
  if (currentQuestion.type === "choice") {
    options = { reply_markup: { inline_keyboard: currentQuestion.options } };
  }
  await sendQuestion(chatId, currentQuestion.question, options);
};

// Обработка команды /start
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  resetUser(chatId);
  await askNextQuestion(chatId);
});

// Обработка текстовых сообщений и фотографий
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const { text, photo } = msg;

  if (!userData[chatId]) return;

  const user = userData[chatId];
  const currentQuestion = questionFlow[user.currentQuestionIndex];

  if (user.state === STATE_WAITING) {
    if (currentQuestion.type === "photo" && photo) {
      try {
        const filePath = await handlePhoto(chatId, photo);
        user.photoUrl = filePath;
        user.responses.push(filePath);
        await finishSurvey(chatId);
      } catch {
        // Ошибка уже обработана в handlePhoto
      }
    } else if (text) {
      user.responses.push(text);
      await finishSurvey(chatId);
    }
  } else if (user.state === STATE_CONFIRMATION) {
    if (text.toLowerCase() === 'да') {
      try {
        await authenticateGoogle();
        await google.sheets('v4').spreadsheets.values.append({
          spreadsheetId,
          range: 'Основная!A:O',
          valueInputOption: 'RAW',
          resource: { values: [[chatId, ...user.responses, user.photoUrl]] },
        });
        await bot.sendMessage(chatId, 'Данные успешно отправлены!\n\nДля повторной отправки данных нажмите: /start\n\nДля связи с менеджером @bring_g');
        delete userData[chatId];
      } catch (error) {
        console.error('Ошибка при отправке данных в Google Таблицу:', error);
        await bot.sendMessage(chatId, 'Произошла ошибка при отправке данных. Попробуйте снова.');
      }
    } else if (text.toLowerCase() === 'нет') {
      resetUser(chatId);
      await askNextQuestion(chatId);
    }
  }
});

// Обработка нажатий на кнопки выбора ПВЗ
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const selectedTariff = query.data;

  if (userData[chatId] && userData[chatId].state === STATE_WAITING) {
    userData[chatId].responses.push(selectedTariff);
    await finishSurvey(chatId);
  }
});

// Обработка необработанных исключений
process.on('uncaughtException', (err) => {
  console.error('Unhandled Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log('Бот запущен...');