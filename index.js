const { Bot, GrammyError, HttpError, Keyboard, InlineKeyboard, InputFile } = require('grammy');
require('dotenv').config();
const fs = require('fs');
const { google } = require('googleapis');
const path = require('path');
const axios = require('axios');

const { promisify } = require('util');
const streamPipeline = promisify(require('stream').pipeline);

// Инициализируем бота с токеном из переменных окружения
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

const spreadsheetId = process.env.SPREADSHEET_ID;
const photoDir = path.join(__dirname, 'photos');
// Убедитесь, что директория существует, или создайте её
if (!fs.existsSync(photoDir)) {
    fs.mkdirSync(photoDir, { recursive: true });
}

//Меню
bot.api.setMyCommands([
    { command: 'start', description: 'Запустить бота' },
]);

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
        question: "Выбор ПВЗ", type: "choice", options: new InlineKeyboard()
            .text('OZON Владикавказ, ул. Павлика Морозова, 49', 'morozov49').row()
            .text('WB Владикавказ, ул. Тельмана, 37', 'telman37').row()
            .text('OZON, WB Владикавказ, улица Вахтангова, 1', 'vakhtangov1').row()
            .text('СДЭК Владикавказ, пр-к Коста, 79', 'costa79').row()
            .text('СДЭК Владикавказ, Астана Кесаева улица, 11', 'kesaeva11').row()
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
    await bot.api.sendMessage(chatId, question, options);
};


// Функция обработки фотографий
const handlePhoto = async (chatId, photo) => {
    try {
        // Получите идентификатор файла
        const fileId = photo[photo.length - 1].file_id;

        // Получите информацию о файле
        const fileInfo = await bot.api.getFile(fileId);

        // Постройте URL для скачивания
        const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${fileInfo.file_path}`;

        // Форматируем дату
        const now = new Date();
        const formattedDate = formatDate(now);

        // Создаем имя файла с датой
        const filePath = path.join(photoDir, `photo_${chatId}_${formattedDate}.jpg`);

        // Загрузка файла и запись в локальную директорию
        const response = await axios({
            url: fileUrl,
            responseType: 'stream',
        });

        // Использование промиса для обработки потока
        await streamPipeline(response.data, fs.createWriteStream(filePath));

        return filePath;
    } catch (error) {
        console.error('Ошибка при получении фото:', error);
        await bot.api.sendMessage(chatId, 'Не удалось получить ваше фото. Пожалуйста, попробуйте снова.');
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
                ? `${questionFlow[index].question}: добавлено`
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
        options = { reply_markup: currentQuestion.options };
    }
    await sendQuestion(chatId, currentQuestion.question, options);
};

// Обработка команды /send
bot.command('start', async (ctx) => {
    const chatId = ctx.chat.id;
    resetUser(chatId);
    await askNextQuestion(chatId);
});


// Обработка текстовых сообщений и фотографий
bot.on('message', async (ctx) => {
    const chatId = ctx.chat.id;
    const { text, photo } = ctx.message;

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
                    range: 'Основная!A:L',
                    valueInputOption: 'RAW',
                    resource: { values: [[chatId, ...user.responses, user.photoUrl]] },
                });
                await bot.api.sendMessage(chatId, 'Данные успешно отправлены!\n\nДля повторной отправки данных нажмите: /start\n\nДля связи с менеджером @bring_g');
                delete userData[chatId];
            } catch (error) {
                console.error('Ошибка при отправке данных в Google Таблицу:', error);
                await bot.api.sendMessage(chatId, 'Произошла ошибка при отправке данных. Попробуйте снова.');
            }
        } else if (text.toLowerCase() === 'нет') {
            resetUser(chatId);
            await askNextQuestion(chatId);
        }
    }
});

// Обработка нажатий на кнопки выбора ПВЗ
bot.on('callback_query:data', async (ctx) => {
    const chatId = ctx.chat.id;
    const selectedTariff = ctx.callbackQuery.data;

    if (userData[chatId] && userData[chatId].state === STATE_WAITING) {
        userData[chatId].responses.push(selectedTariff);
        await finishSurvey(chatId);
    }
});

// функцию для форматирования даты:
const formatDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Месяцы от 0 до 11
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    
    return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
};

// Обработка необработанных исключений
process.on('uncaughtException', (err) => {
    console.error('Unhandled Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
////////////////////

//ОБРОБОТЧИК ОШИБОК
bot.catch((err) => {
    const ctx = err.ctx;
    console.error(`Error while handling update ${ctx.update.update_id}:`);
    const e = err.error;

    if (e instanceof GrammyError) {
        console.error('Error in request:', e.description);
    } else if (e instanceof HttpError) {
        console.error('Could not contact Telegram:', e);
    } else {
        console.error('Unknown error:', e);
    }
})
// Запускаем бота
console.log('Бот запущен...');
bot.start();
