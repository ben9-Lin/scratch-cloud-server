const express = require('express');
const cors = require('cors');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const path = require('path');
const crypto = require('crypto');

const sessions = new Map();
const teacherSessions = new Map();

const TEACHERS_FILE =
    path.join(__dirname, 'teachers.json');

const SETTINGS_FILE =
    path.join(__dirname, 'settings.json');

function readSettings() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) {
            return {
                sitePrefix: '校內'
            };
        }

        const data =
            JSON.parse(
                fs.readFileSync(
                    SETTINGS_FILE,
                    'utf8'
                )
            );

        return {
            sitePrefix:
                (data.sitePrefix || '校內')
                    .toString()
                    .trim()
        };

    } catch (error) {
        console.error(
            '讀取 settings.json 失敗',
            error
        );

        return {
            sitePrefix: '校內'
        };
    }
}

function writeSettings(settings) {
    fs.writeFileSync(
        SETTINGS_FILE,
        JSON.stringify(
            settings,
            null,
            2
        )
    );
}




const SESSION_TTL_MS = 8 * 60 * 60 * 1000;


function requireTeacher(req, res, next) {
    const auth = req.headers.authorization || '';

    if (!auth.startsWith('Bearer ')) {
        return res.status(401).json({
            status: 'error',
            message: '教師尚未登入'
        });
    }

    const token = auth.slice(7);
    const session = teacherSessions.get(token);

    if (!session) {
        return res.status(401).json({
            status: 'error',
            message: '教師登入已失效'
        });
    }

    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        teacherSessions.delete(token);

        return res.status(401).json({
            status: 'error',
            message: '教師登入已逾時'
        });
    }

    // 正式教師帳號：每次請求都同步 teachers.json 的最新權限
    if (
        session.legacy !== true &&
        session.username
    ) {
        const teachers =
            readTeachers();

        const currentTeacher =
            teachers.find(
                item =>
                    item.username === session.username
            );

        if (!currentTeacher) {
            teacherSessions.delete(token);

            return res.status(401).json({
                status: 'error',
                message: '教師帳號已不存在，請重新登入'
            });
        }

        if (currentTeacher.active === false) {
            teacherSessions.delete(token);

            return res.status(403).json({
                status: 'error',
                message: '此教師帳號目前已停用'
            });
        }

        session.name =
            currentTeacher.name || '';

        session.role =
            currentTeacher.role || 'teacher';

        session.managedClasses =
            Array.isArray(
                currentTeacher.managedClasses
            )
                ? currentTeacher.managedClasses
                : [];
    }

    req.teacher = session;
    req.teacherToken = token;

    next();
}


function requireAdmin(req, res, next) {
    if (
        !req.teacher ||
        req.teacher.role !== 'admin'
    ) {
        return res.status(403).json({
            status: 'error',
            message: '需要管理者權限'
        });
    }

    next();
}


function canManageClass(teacher, className) {
    if (!teacher) {
        return false;
    }

    // 系統管理員可管理全校所有班級
    if (teacher.role === 'admin') {
        return true;
    }

    const target =
        (className || '')
            .toString()
            .trim();

    if (!target) {
        return false;
    }

    const managedClasses =
        Array.isArray(teacher.managedClasses)
            ? teacher.managedClasses
            : [];

    // 舊系統遷移期間的特殊權限
    if (managedClasses.includes('*')) {
        return true;
    }

    return managedClasses.includes(target);
}


function requireManagedClass(req, res, next) {
    const className =
        (
            req.params.className ||
            req.body?.className ||
            ''
        )
            .toString()
            .trim();

    if (!className) {
        return res.status(400).json({
            status: 'error',
            message: '缺少班級資料'
        });
    }

    if (
        !canManageClass(
            req.teacher,
            className
        )
    ) {
        return res.status(403).json({
            status: 'error',
            message: '沒有管理此班級的權限'
        });
    }

    next();
}


function requireAuth(req, res, next) {
    const auth = req.headers.authorization || '';

    if (!auth.startsWith('Bearer ')) {
        return res.status(401).json({
            status: 'error',
            message: '請先登入'
        });
    }

    const token = auth.slice(7);
    const session = sessions.get(token);

    if (!session) {
        return res.status(401).json({
            status: 'error',
            message: '登入已失效，請重新登入'
        });
    }

    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(token);

        return res.status(401).json({
            status: 'error',
            message: '登入已逾時，請重新登入'
        });
    }

    req.studentId = session.studentId;
    req.studentName = session.name || '';

    next();
}

const multer = require('multer')
const { OAuth2Client } = require('google-auth-library');
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
 }

 const upload = multer({
   dest: UPLOAD_DIR,
   limits: {
      fileSize: 100 * 1024 * 1024
    }
  });

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 健康檢查
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'scratch-api'
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy'
  });
});

// 儲存作品
app.post('/projects', (req, res) => {
  try {
    const id = crypto.randomUUID();

    const project = {
      id,
      name: req.body.name || '未命名作品',
      content: req.body.content || {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const filePath = path.join(DATA_DIR, `${id}.json`);

    fs.writeFileSync(
      filePath,
      JSON.stringify(project, null, 2),
      'utf8'
    );

    res.status(201).json({
      status: 'saved',
      id,
      name: project.name
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: 'error',
      message: '儲存作品失敗'
    });
  }
});

// 讀取作品
app.get('/projects/:id', (req, res) => {
  try {
    const filePath = path.join(
      DATA_DIR,
      `${req.params.id}.json`
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        status: 'error',
        message: '找不到作品'
      });
    }

    const project = JSON.parse(
      fs.readFileSync(filePath, 'utf8')
    );

    res.json(project);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: 'error',
      message: '讀取作品失敗'
    });
  }
});

// 列出所有作品
app.get('/projects', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(file => file.endsWith('.json'));

    const projects = files.map(file => {
      const project = JSON.parse(
        fs.readFileSync(path.join(DATA_DIR, file), 'utf8')
      );

      return {
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt
      };
    });

    res.json(projects);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: 'error',
      message: '讀取作品清單失敗'
    });
  }
});


// 取得某位學生的作品清單
app.get('/projects/list/all', requireAuth, (req, res) => {
    try {
        const studentId = req.studentId;

        if (!studentId) {
            return res.status(400).json({
                status: 'error',
                message: '缺少學生帳號'
            });
        }

        const studentDir = path.join(UPLOAD_DIR, studentId);

        if (!fs.existsSync(studentDir)) {
            return res.json({
                status: 'ok',
                projects: []
            });
        }

        const files = fs.readdirSync(studentDir)
            .filter(name => name.endsWith('.meta.json'));

        const projects = files.map(file => {
            const fullPath = path.join(studentDir, file);

            try {
                return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            } catch (e) {
                return null;
            }
        })
        .filter(Boolean)
        .sort((a, b) =>
            new Date(b.createdAt) - new Date(a.createdAt)
        );

        res.json({
            status: 'ok',
            studentId,
            projects
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '讀取作品清單失敗'
        });
    }
});


// 下載某位學生自己的 Scratch 作品
app.get('/projects/file/:id', requireAuth, (req, res) => {
    try {
        const studentId = req.studentId;

        const projectId = (req.params.id || '')
            .toString()
            .replace(/[^a-zA-Z0-9_-]/g, '');

        if (!studentId || !projectId) {
            return res.status(400).json({
                status: 'error',
                message: '缺少學生帳號或作品 ID'
            });
        }

        const studentDir = path.join(UPLOAD_DIR, studentId);
        const sb3Path = path.join(studentDir, `${projectId}.sb3`);

        if (!fs.existsSync(sb3Path)) {
            return res.status(404).json({
                status: 'error',
                message: '找不到作品'
            });
        }

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${projectId}.sb3"`
        );

        res.sendFile(sb3Path);

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '下載作品失敗'
        });
    }
});


// 刪除某位學生自己的 Scratch 作品
app.delete('/projects/file/:id', requireAuth, (req, res) => {
    try {
        const studentId = req.studentId;

        const projectId = (req.params.id || '')
            .toString()
            .replace(/[^a-zA-Z0-9_-]/g, '');

        if (!studentId || !projectId) {
            return res.status(400).json({
                status: 'error',
                message: '缺少學生帳號或作品 ID'
            });
        }

        const studentDir = path.join(UPLOAD_DIR, studentId);
        const sb3Path = path.join(studentDir, `${projectId}.sb3`);
        const metaPath = path.join(studentDir, `${projectId}.meta.json`);

        if (!fs.existsSync(sb3Path) && !fs.existsSync(metaPath)) {
            return res.status(404).json({
                status: 'error',
                message: '找不到作品'
            });
        }

        if (fs.existsSync(sb3Path)) {
            fs.unlinkSync(sb3Path);
        }

        if (fs.existsSync(metaPath)) {
            fs.unlinkSync(metaPath);
        }

        res.json({
            status: 'deleted',
            id: projectId,
            studentId
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '刪除作品失敗'
        });
    }
});


// 查詢某位學生是否已有同名作品
app.get('/projects/name/find', requireAuth, (req, res) => {
    try {
        const studentId = req.studentId;

        const projectName = (req.query.name || '')
            .toString()
            .trim();

        if (!studentId || !projectName) {
            return res.status(400).json({
                status: 'error',
                message: '缺少學生帳號或作品名稱'
            });
        }

        const studentDir = path.join(UPLOAD_DIR, studentId);

        if (!fs.existsSync(studentDir)) {
            return res.json({
                status: 'ok',
                exists: false,
                project: null
            });
        }

        const metaFiles = fs.readdirSync(studentDir)
            .filter(name => name.endsWith('.meta.json'));

        let found = null;

        for (const file of metaFiles) {
            const fullPath = path.join(studentDir, file);

            try {
                const meta = JSON.parse(
                    fs.readFileSync(fullPath, 'utf8')
                );

                if (meta.name === projectName) {
                    if (
                        !found ||
                        new Date(meta.createdAt) > new Date(found.createdAt)
                    ) {
                        found = meta;
                    }
                }
            } catch (e) {
                // 略過損壞的 metadata
            }
        }

        res.json({
            status: 'ok',
            exists: Boolean(found),
            project: found
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '查詢作品失敗'
        });
    }
});


// 覆蓋某位學生既有的 Scratch 作品
app.post('/projects/overwrite/:id', requireAuth, upload.single('file'), (req, res) => {
    try {
        const studentId = req.studentId;

        const projectId = (req.params.id || '')
            .toString()
            .replace(/[^a-zA-Z0-9_-]/g, '');

        const projectName = (req.body.name || '')
            .toString()
            .trim();

        if (!studentId || !projectId) {
            return res.status(400).json({
                status: 'error',
                message: '缺少學生帳號或作品 ID'
            });
        }

        if (!req.file) {
            return res.status(400).json({
                status: 'error',
                message: '缺少 SB3 檔案'
            });
        }

        const studentDir = path.join(UPLOAD_DIR, studentId);

        const sb3Path = path.join(
            studentDir,
            `${projectId}.sb3`
        );

        const metaPath = path.join(
            studentDir,
            `${projectId}.meta.json`
        );

        if (!fs.existsSync(metaPath)) {
            fs.unlinkSync(req.file.path);

            return res.status(404).json({
                status: 'error',
                message: '找不到原作品'
            });
        }

        const oldMeta = JSON.parse(
            fs.readFileSync(metaPath, 'utf8')
        );

        fs.renameSync(
            req.file.path,
            sb3Path
        );

        const metadata = {
            ...oldMeta,
            studentId,
            name: projectName || oldMeta.name,
            filename: `${projectId}.sb3`,
            originalName: req.file.originalname,
            size: req.file.size,
            updatedAt: new Date().toISOString()
        };

        fs.writeFileSync(
            metaPath,
            JSON.stringify(metadata, null, 2)
        );

        res.json({
            status: 'overwritten',
            project: metadata
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '覆蓋作品失敗'
        });
    }
});


// 學生登入
app.post('/auth/login', express.json(), async (req, res) => {
    try {
        const studentId = (req.body.studentId || '')
            .toString()
            .trim();

        const password = (req.body.password || '')
            .toString();

        if (!studentId || !password) {
            return res.status(400).json({
                status: 'error',
                message: '請輸入學號和密碼'
            });
        }

        const studentsFile = path.join(__dirname, 'students.json');

        if (!fs.existsSync(studentsFile)) {
            return res.status(500).json({
                status: 'error',
                message: '學生帳號資料不存在'
            });
        }

        const students = JSON.parse(
            fs.readFileSync(studentsFile, 'utf8')
        );

        const student = students.find(item =>
            item.studentId === studentId
        );

        const passwordOk =
            student &&
            student.passwordHash &&
            await bcrypt.compare(
                password,
                student.passwordHash
            );

        if (!passwordOk) {
            return res.status(401).json({
                status: 'error',
                message: '學號或密碼錯誤'
            });
        }

        if (student.active === false) {
            return res.status(403).json({
                status: 'error',
                message: '此帳號目前已停用，請洽老師'
            });
        }

        const token = crypto.randomUUID();

        sessions.set(token, {
            studentId: student.studentId,
            name: student.name || '',
            createdAt: Date.now()
        });

        res.json({
            status: 'ok',
            token,
            student: {
                studentId: student.studentId,
                name: student.name || '',
                className: student.className || '',
                seatNo: student.seatNo || ''
            }
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '登入驗證失敗'
        });
    }
});




// ==============================
// 學生自行修改密碼
// ==============================
app.post(
    '/auth/change-password',
    express.json(),
    async (req, res) => {
        try {
            const auth =
                req.headers.authorization || '';

            if (!auth.startsWith('Bearer ')) {
                return res.status(401).json({
                    status: 'error',
                    message: '尚未登入'
                });
            }

            const token = auth.slice(7);
            const session = sessions.get(token);

            if (!session) {
                return res.status(401).json({
                    status: 'error',
                    message: '登入已逾時，請重新登入'
                });
            }

            const currentPassword =
                (req.body.currentPassword || '')
                    .toString();

            const newPassword =
                (req.body.newPassword || '')
                    .toString();

            if (!currentPassword) {
                return res.status(400).json({
                    status: 'error',
                    message: '請輸入目前密碼'
                });
            }

            if (newPassword.length < 4) {
                return res.status(400).json({
                    status: 'error',
                    message: '新密碼至少需要 4 個字元'
                });
            }

            if (currentPassword === newPassword) {
                return res.status(400).json({
                    status: 'error',
                    message: '新密碼不可與目前密碼相同'
                });
            }

            const studentsFile =
                path.join(
                    __dirname,
                    'students.json'
                );

            const students =
                JSON.parse(
                    fs.readFileSync(
                        studentsFile,
                        'utf8'
                    )
                );

            const student =
                students.find(
                    item =>
                        item.studentId ===
                        session.studentId
                );

            if (!student) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到學生帳號'
                });
            }

            const passwordOk =
                await bcrypt.compare(
                    currentPassword,
                    student.passwordHash
                );

            if (!passwordOk) {
                return res.status(401).json({
                    status: 'error',
                    message: '目前密碼錯誤'
                });
            }

            student.passwordHash =
                await bcrypt.hash(
                    newPassword,
                    10
                );

            fs.writeFileSync(
                studentsFile,
                JSON.stringify(
                    students,
                    null,
                    2
                ),
                'utf8'
            );

            // 修改密碼後讓目前登入失效
            sessions.delete(token);

            return res.json({
                status: 'ok',
                message: '密碼修改成功，請重新登入'
            });

        } catch (error) {
            console.error(
                '[AUTH] change password error',
                error
            );

            return res.status(500).json({
                status: 'error',
                message: '修改密碼失敗'
            });
        }
    }
);



// ==============================
// 學生自行修改密碼
// ==============================
app.post(
    '/auth/change-password',
    express.json(),
    async (req, res) => {
        try {
            const auth =
                req.headers.authorization || '';

            if (!auth.startsWith('Bearer ')) {
                return res.status(401).json({
                    status: 'error',
                    message: '尚未登入'
                });
            }

            const token = auth.slice(7);
            const session = sessions.get(token);

            if (!session) {
                return res.status(401).json({
                    status: 'error',
                    message: '登入已逾時，請重新登入'
                });
            }

            const currentPassword =
                (req.body.currentPassword || '')
                    .toString();

            const newPassword =
                (req.body.newPassword || '')
                    .toString();

            if (!currentPassword) {
                return res.status(400).json({
                    status: 'error',
                    message: '請輸入目前密碼'
                });
            }

            if (newPassword.length < 4) {
                return res.status(400).json({
                    status: 'error',
                    message: '新密碼至少需要 4 個字元'
                });
            }

            if (currentPassword === newPassword) {
                return res.status(400).json({
                    status: 'error',
                    message: '新密碼不可與目前密碼相同'
                });
            }

            const studentsFile =
                path.join(
                    __dirname,
                    'students.json'
                );

            const students =
                JSON.parse(
                    fs.readFileSync(
                        studentsFile,
                        'utf8'
                    )
                );

            const student =
                students.find(
                    item =>
                        item.studentId ===
                        session.studentId
                );

            if (!student) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到學生帳號'
                });
            }

            const passwordOk =
                await bcrypt.compare(
                    currentPassword,
                    student.passwordHash
                );

            if (!passwordOk) {
                return res.status(401).json({
                    status: 'error',
                    message: '目前密碼錯誤'
                });
            }

            student.passwordHash =
                await bcrypt.hash(
                    newPassword,
                    10
                );

            fs.writeFileSync(
                studentsFile,
                JSON.stringify(
                    students,
                    null,
                    2
                ),
                'utf8'
            );

            // 修改密碼後讓目前登入失效
            sessions.delete(token);

            return res.json({
                status: 'ok',
                message: '密碼修改成功，請重新登入'
            });

        } catch (error) {
            console.error(
                '[AUTH] change password error',
                error
            );

            return res.status(500).json({
                status: 'error',
                message: '修改密碼失敗'
            });
        }
    }
);



// ==============================
// Google 登入
// 只允許已綁定的學生帳號
// ==============================
app.post(
    '/auth/google',
    express.json(),
    async (req, res) => {
        try {
            if (!GOOGLE_CLIENT_ID) {
                return res.status(500).json({
                    status: 'error',
                    message: 'Google Login 尚未設定'
                });
            }

            const credential =
                (req.body.credential || '')
                    .toString()
                    .trim();

            if (!credential) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少 Google credential'
                });
            }

            const ticket =
                await googleClient.verifyIdToken({
                    idToken: credential,
                    audience: GOOGLE_CLIENT_ID
                });

            const payload =
                ticket.getPayload();

            if (!payload) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Google 驗證失敗'
                });
            }

            const googleSub =
                (payload.sub || '')
                    .toString()
                    .trim();

            const googleEmail =
                (payload.email || '')
                    .toString()
                    .trim()
                    .toLowerCase();

            const emailVerified =
                payload.email_verified === true;

            if (
                !googleSub ||
                !googleEmail ||
                !emailVerified
            ) {
                return res.status(401).json({
                    status: 'error',
                    message: 'Google 帳號驗證資料不完整'
                });
            }

            const studentsFile =
                path.join(
                    __dirname,
                    'students.json'
                );

            const students =
                JSON.parse(
                    fs.readFileSync(
                        studentsFile,
                        'utf8'
                    )
                );

            const student =
                students.find(item => {
                    if (!item) {
                        return false;
                    }

                    const boundSub =
                        (item.googleSub || '')
                            .toString()
                            .trim();

                    const boundEmail =
                        (item.googleEmail || '')
                            .toString()
                            .trim()
                            .toLowerCase();

                    return (
                        boundSub === googleSub ||
                        (
                            boundEmail &&
                            boundEmail === googleEmail
                        )
                    );
                });

            if (!student) {
                return res.status(403).json({
                    status: 'error',
                    code: 'GOOGLE_NOT_LINKED',
                    message:
                        '此 Google 帳號尚未綁定平台帳號'
                });
            }

            if (student.active === false) {
                return res.status(403).json({
                    status: 'error',
                    message: '此帳號目前已停用，請洽老師'
                });
            }

            // 第一次以 Email 對上時，
            // 自動記錄穩定的 Google sub。
            let changed = false;

            if (
                !student.googleSub &&
                googleSub
            ) {
                student.googleSub =
                    googleSub;

                changed = true;
            }

            if (
                !student.googleEmail &&
                googleEmail
            ) {
                student.googleEmail =
                    googleEmail;

                changed = true;
            }

            if (changed) {
                fs.writeFileSync(
                    studentsFile,
                    JSON.stringify(
                        students,
                        null,
                        2
                    ),
                    'utf8'
                );
            }

            const token =
                crypto.randomUUID();

            sessions.set(token, {
                studentId:
                    student.studentId,
                name:
                    student.name || '',
                createdAt:
                    Date.now(),
                loginMethod:
                    'google',
                googleSub
            });

            return res.json({
                status: 'ok',
                token,
                loginMethod: 'google',
                student: {
                    studentId:
                        student.studentId,
                    name:
                        student.name || '',
                    className:
                        student.className || '',
                    seatNo:
                        student.seatNo || ''
                }
            });

        } catch (error) {
            console.error(
                '[AUTH] Google login error',
                error
            );

            return res.status(401).json({
                status: 'error',
                message: 'Google 登入驗證失敗'
            });
        }
    }
);


// 登出並使目前 Token 失效
app.post('/auth/logout', (req, res) => {
    const auth = req.headers.authorization || '';

    if (!auth.startsWith('Bearer ')) {
        return res.json({
            status: 'ok'
        });
    }

    const token = auth.slice(7);

    sessions.delete(token);

    res.json({
        status: 'ok'
    });
});

// 驗證目前登入 Token
app.get('/auth/me', (req, res) => {
    const auth = req.headers.authorization || '';

    if (!auth.startsWith('Bearer ')) {
        return res.status(401).json({
            status: 'error',
            message: '尚未登入'
        });
    }

    const token = auth.slice(7);
    const session = sessions.get(token);

    if (!session) {
        return res.status(401).json({
            status: 'error',
            message: '登入已失效'
        });
    }

    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(token);

        return res.status(401).json({
            status: 'error',
            message: '登入已逾時，請重新登入'
        });
    }

    res.json({
        status: 'ok',
        student: {
            studentId: session.studentId,
            name: session.name
        }
    });
});



// 教師登入

function readTeachers() {
    try {
        if (!fs.existsSync(TEACHERS_FILE)) {
            return [];
        }

        const text =
            fs.readFileSync(
                TEACHERS_FILE,
                'utf8'
            );

        const teachers =
            JSON.parse(text || '[]');

        return Array.isArray(teachers)
            ? teachers
            : [];

    } catch (error) {
        console.error(
            '讀取 teachers.json 失敗',
            error
        );

        return [];
    }
}


function writeTeachers(teachers) {
    fs.writeFileSync(
        TEACHERS_FILE,
        JSON.stringify(
            teachers,
            null,
            2
        )
    );
}


app.post('/teacher/login', express.json(), async (req, res) => {
    try {
        const username =
            (req.body.username || '')
                .toString()
                .trim();

        const password =
            (req.body.password || '')
                .toString();

        if (!password) {
            return res.status(400).json({
                status: 'error',
                message: '請輸入教師密碼'
            });
        }

        // 正式教師帳號登入
        if (username) {
            const teachers =
                readTeachers();

            const teacher =
                teachers.find(
                    item =>
                        item.username === username
                );

            if (!teacher) {
                return res.status(401).json({
                    status: 'error',
                    message: '教師帳號或密碼錯誤'
                });
            }

            if (teacher.active === false) {
                return res.status(403).json({
                    status: 'error',
                    message: '此教師帳號目前已停用'
                });
            }

            const ok =
                await bcrypt.compare(
                    password,
                    teacher.passwordHash || ''
                );

            if (!ok) {
                return res.status(401).json({
                    status: 'error',
                    message: '教師帳號或密碼錯誤'
                });
            }

            const token =
                crypto.randomUUID();

            teacherSessions.set(token, {
                username:
                    teacher.username,

                name:
                    teacher.name || '',

                role:
                    teacher.role || 'teacher',

                managedClasses:
                    Array.isArray(
                        teacher.managedClasses
                    )
                        ? teacher.managedClasses
                        : [],

                legacy: false,
                createdAt: Date.now()
            });

            return res.json({
                status: 'ok',
                token,

                teacher: {
                    username:
                        teacher.username,

                    name:
                        teacher.name || '',

                    role:
                        teacher.role || 'teacher',

                    managedClasses:
                        Array.isArray(
                            teacher.managedClasses
                        )
                            ? teacher.managedClasses
                            : []
                }
            });
        }

                // 正式教師帳號系統已啟用，不再接受只有密碼的舊式登入
        return res.status(400).json({
            status: 'error',
            message: '請輸入教師帳號與密碼'
        });

} catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '教師登入失敗'
        });
    }
});


// 取得目前教師登入資訊
app.get(
    '/teacher/me',
    requireTeacher,
    (req, res) => {
        res.json({
            status: 'ok',

            teacher: {
                username:
                    req.teacher.username || '',

                name:
                    req.teacher.name || '',

                role:
                    req.teacher.role || 'teacher',

                managedClasses:
                    Array.isArray(
                        req.teacher.managedClasses
                    )
                        ? req.teacher.managedClasses
                        : [],

                legacy:
                    req.teacher.legacy === true
            }
        });
    }
);



// 管理者：取得教師帳號清單
app.get(
    '/teacher/accounts',
    requireTeacher,
    requireAdmin,
    (req, res) => {
        try {
            const teachers =
                readTeachers();

            const safeTeachers =
                teachers.map(teacher => ({
                    username:
                        teacher.username || '',

                    name:
                        teacher.name || '',

                    role:
                        teacher.role || 'teacher',

                    managedClasses:
                        Array.isArray(
                            teacher.managedClasses
                        )
                            ? teacher.managedClasses
                            : [],

                    active:
                        teacher.active !== false
                }));

            res.json({
                status: 'ok',
                teachers: safeTeachers
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '讀取教師帳號失敗'
            });
        }
    }
);




function findTeacherClassConflict(
    teachers,
    username,
    role,
    managedClasses,
    active = true
) {
    // 管理員本來就具有全校權限，
    // 不參與一般教師班級重複判斷
    if (
        role === 'admin' ||
        active === false
    ) {
        return null;
    }

    const wantedClasses =
        new Set(
            (
                Array.isArray(managedClasses)
                    ? managedClasses
                    : []
            )
                .map(item =>
                    item.toString().trim()
                )
                .filter(Boolean)
        );

    for (const other of teachers) {
        if (!other) {
            continue;
        }

        // 修改自己時，不與自己比較
        if (
            other.username === username
        ) {
            continue;
        }

        // admin 不占用班級
        if (
            other.role === 'admin'
        ) {
            continue;
        }

        // 停用教師釋放班級
        if (
            other.active === false
        ) {
            continue;
        }

        const otherClasses =
            Array.isArray(
                other.managedClasses
            )
                ? other.managedClasses
                : [];

        for (
            const className
            of otherClasses
        ) {
            const normalized =
                className
                    .toString()
                    .trim();

            if (
                normalized &&
                wantedClasses.has(
                    normalized
                )
            ) {
                return {
                    className:
                        normalized,

                    teacher:
                        other
                };
            }
        }
    }

    return null;
}


// 管理者：新增教師帳號
app.post(
    '/teacher/accounts',
    requireTeacher,
    requireAdmin,
    express.json(),
    async (req, res) => {
        try {
            const username =
                (req.body.username || '')
                    .toString()
                    .trim();

            const name =
                (req.body.name || '')
                    .toString()
                    .trim();

            const password =
                (req.body.password || '')
                    .toString();

            const role =
                (req.body.role || 'teacher')
                    .toString()
                    .trim();

            const managedClasses =
                Array.isArray(
                    req.body.managedClasses
                )
                    ? req.body.managedClasses
                        .map(item =>
                            item
                                .toString()
                                .trim()
                        )
                        .filter(Boolean)
                    : [];

            if (!username) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少教師帳號'
                });
            }

            if (!name) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少教師姓名'
                });
            }

            if (!password) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少教師密碼'
                });
            }

            if (
                !['admin', 'teacher']
                    .includes(role)
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: '教師角色不正確'
                });
            }

            const teachers =
                readTeachers();

            const existing =
                teachers.find(
                    teacher =>
                        teacher.username === username
                );

            if (existing) {
                return res.status(409).json({
                    status: 'error',
                    message: '教師帳號已存在'
                });
            }

    
        const classConflict =
            findTeacherClassConflict(
                teachers,
                username,
                role,
                managedClasses,
                true
            );

        if (classConflict) {
            const owner =
                classConflict.teacher;

            return res.status(409).json({
                status: 'error',
                message:
                    `班級 ${classConflict.className} 已由 ` +
                    `${owner.username}` +
                    (
                        owner.name
                            ? `（${owner.name}）`
                            : ''
                    ) +
                    ' 管理'
            });
        }

        const passwordHash =
                await bcrypt.hash(
                    password,
                    10
                );

            teachers.push({
                username,
                name,
                passwordHash,
                role,
                managedClasses,
                active: true
            });

            writeTeachers(teachers);

            res.json({
                status: 'ok',
                teacher: {
                    username,
                    name,
                    role,
                    managedClasses,
                    active: true
                }
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '新增教師帳號失敗'
            });
        }
    }
);



// 管理者：修改教師帳號
app.put(
    '/teacher/accounts/:username',
    requireTeacher,
    requireAdmin,
    express.json(),
    async (req, res) => {
        try {
            const username =
                (req.params.username || '')
                    .toString()
                    .trim();

            const teachers =
                readTeachers();

            const teacher =
                teachers.find(
                    item =>
                        item.username === username
                );

            if (!teacher) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到教師帳號'
                });
            }

            const newName =
                req.body.name !== undefined
                    ? req.body.name
                        .toString()
                        .trim()
                    : teacher.name;

            const newRole =
                req.body.role !== undefined
                    ? req.body.role
                        .toString()
                        .trim()
                    : teacher.role;

            const newManagedClasses =
                req.body.managedClasses !== undefined
                    ? (
                        Array.isArray(
                            req.body.managedClasses
                        )
                            ? req.body.managedClasses
                                .map(item =>
                                    item
                                        .toString()
                                        .trim()
                                )
                                .filter(Boolean)
                            : []
                    )
                    : (
                        Array.isArray(
                            teacher.managedClasses
                        )
                            ? teacher.managedClasses
                            : []
                    );

            const newActive =
                req.body.active !== undefined
                    ? req.body.active
                    : teacher.active !== false;

            if (
                !['admin', 'teacher']
                    .includes(newRole)
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: '教師角色不正確'
                });
            }

            if (
                typeof newActive !== 'boolean'
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: 'active 必須是 true 或 false'
                });
            }

            // 不允許停用自己
            if (
                username === req.teacher.username &&
                newActive === false
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: '不能停用目前登入中的自己'
                });
            }

            const activeAdmins =
                teachers.filter(item =>
                    item.role === 'admin' &&
                    item.active !== false
                );

            // 不允許把最後一位 admin 降級或停用
            if (
                teacher.role === 'admin' &&
                teacher.active !== false &&
                activeAdmins.length === 1 &&
                (
                    newRole !== 'admin' ||
                    newActive === false
                )
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: '系統至少必須保留一位啟用中的管理者'
                });
            }

            
        const classConflict =
            findTeacherClassConflict(
                teachers,
                username,
                newRole,
                newManagedClasses,
                newActive
            );

        if (classConflict) {
            const owner =
                classConflict.teacher;

            return res.status(409).json({
                status: 'error',
                message:
                    `班級 ${classConflict.className} 已由 ` +
                    `${owner.username}` +
                    (
                        owner.name
                            ? `（${owner.name}）`
                            : ''
                    ) +
                    ' 管理'
            });
        }

teacher.name =
                newName;

            teacher.role =
                newRole;

            teacher.managedClasses =
                newManagedClasses;

            teacher.active =
                newActive;

            if (
                req.body.password !== undefined &&
                req.body.password !== ''
            ) {
                teacher.passwordHash =
                    await bcrypt.hash(
                        req.body.password
                            .toString(),
                        10
                    );
            }

            writeTeachers(teachers);

            res.json({
                status: 'ok',
                teacher: {
                    username:
                        teacher.username,

                    name:
                        teacher.name || '',

                    role:
                        teacher.role,

                    managedClasses:
                        teacher.managedClasses,

                    active:
                        teacher.active !== false
                }
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '修改教師帳號失敗'
            });
        }
    }
);




// 管理者：刪除教師帳號
app.delete(
    '/teacher/accounts/:username',
    requireTeacher,
    requireAdmin,
    async (req, res) => {
        try {
            const username =
                (req.params.username || '')
                    .toString()
                    .trim();

            if (!username) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少教師帳號'
                });
            }

            // 不可刪除目前登入中的自己
            if (
                username ===
                req.teacher.username
            ) {
                return res.status(400).json({
                    status: 'error',
                    message:
                        '不能刪除目前登入中的自己'
                });
            }

            const teachers =
                readTeachers();

            const index =
                teachers.findIndex(
                    item =>
                        item.username ===
                        username
                );

            if (index < 0) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到教師帳號'
                });
            }

            const target =
                teachers[index];

            // 若刪的是啟用中的 admin，
            // 至少要留下另一位啟用中的 admin
            if (
                target.role === 'admin' &&
                target.active !== false
            ) {
                const activeAdmins =
                    teachers.filter(
                        item =>
                            item.role ===
                                'admin' &&
                            item.active !==
                                false
                    );

                if (
                    activeAdmins.length <= 1
                ) {
                    return res.status(400).json({
                        status: 'error',
                        message:
                            '系統至少必須保留一位啟用中的管理者'
                    });
                }
            }

            teachers.splice(
                index,
                1
            );

            writeTeachers(teachers);

            // 讓被刪除帳號所有既有登入失效
            for (
                const [token, session]
                of teacherSessions.entries()
            ) {
                if (
                    session.username ===
                    username
                ) {
                    teacherSessions.delete(
                        token
                    );
                }
            }

            res.json({
                status: 'ok',
                message:
                    `教師帳號 ${username} 已刪除`
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '刪除教師帳號失敗'
            });
        }
    }
);



// 管理者：系統狀態
app.get(
    '/teacher/system-status',
    requireTeacher,
    requireAdmin,
    (req, res) => {
        try {
            const teachers =
                readTeachers();

            const studentsFile =
                path.join(
                    __dirname,
                    'students.json'
                );

            const students =
                JSON.parse(
                    fs.readFileSync(
                        studentsFile,
                        'utf8'
                    )
                );

            const classNames =
                new Set(
                    students
                        .map(student =>
                            (
                                student.className ||
                                ''
                            )
                                .toString()
                                .trim()
                        )
                        .filter(Boolean)
                );

            const inactiveStudents =
                students.filter(
                    student =>
                        student.active === false
                ).length;

            const inactiveTeachers =
                teachers.filter(
                    teacher =>
                        teacher.active === false
                ).length;

            let projectCount = 0;

            const uploadsRoot =
                path.join(
                    __dirname,
                    'uploads'
                );

            function countSb3Files(dir) {
                if (
                    !fs.existsSync(dir)
                ) {
                    return;
                }

                const entries =
                    fs.readdirSync(
                        dir,
                        {
                            withFileTypes: true
                        }
                    );

                for (
                    const entry
                    of entries
                ) {
                    const fullPath =
                        path.join(
                            dir,
                            entry.name
                        );

                    if (
                        entry.isDirectory()
                    ) {
                        countSb3Files(
                            fullPath
                        );
                    } else if (
                        entry.isFile() &&
                        entry.name
                            .toLowerCase()
                            .endsWith('.sb3')
                    ) {
                        projectCount++;
                    }
                }
            }

            countSb3Files(
                uploadsRoot
            );

            res.json({
                status: 'ok',

                system: {
                    api: '正常',

                    teacherCount:
                        teachers.length,

                    inactiveTeacherCount:
                        inactiveTeachers,

                    studentCount:
                        students.length,

                    inactiveStudentCount:
                        inactiveStudents,

                    classCount:
                        classNames.size,

                    projectCount
                }
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message:
                    '讀取系統狀態失敗'
            });
        }
    }
);


// 管理者：取得全校所有班級
app.get(
    '/teacher/classes',
    requireTeacher,
    requireAdmin,
    (req, res) => {
        try {
            const studentsFile =
                path.join(
                    __dirname,
                    'students.json'
                );

            const students =
                JSON.parse(
                    fs.readFileSync(
                        studentsFile,
                        'utf8'
                    )
                );

            const classMap =
                new Map();

            for (const student of students) {
                const className =
                    (student.className || '')
                        .toString()
                        .trim();

                if (!className) {
                    continue;
                }

                if (!classMap.has(className)) {
                    classMap.set(
                        className,
                        {
                            className,
                            studentCount: 0,
                            activeCount: 0,
                            inactiveCount: 0
                        }
                    );
                }

                const item =
                    classMap.get(className);

                item.studentCount++;

                if (student.active === false) {
                    item.inactiveCount++;
                } else {
                    item.activeCount++;
                }
            }

            const classes =
                Array.from(
                    classMap.values()
                )
                .sort(
                    (a, b) =>
                        a.className.localeCompare(
                            b.className,
                            undefined,
                            {numeric: true}
                        )
                );

            res.json({
                status: 'ok',
                totalClasses:
                    classes.length,
                classes
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '讀取班級資料失敗'
            });
        }
    }
);



// 管理者：刪除整個班級
app.delete(
    '/teacher/classes/:className',
    requireTeacher,
    requireAdmin,
    express.json(),
    (req, res) => {
        try {
            const className =
                (req.params.className || '')
                    .toString()
                    .trim();

            const confirmClassName =
                (req.body.confirmClassName || '')
                    .toString()
                    .trim();

            if (!className) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少班級名稱'
                });
            }

            if (
                confirmClassName !==
                className
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: '班級確認名稱不一致'
                });
            }

            const studentsFile =
                path.join(
                    __dirname,
                    'students.json'
                );

            const teachersFile =
                path.join(
                    __dirname,
                    'teachers.json'
                );

            const students =
                JSON.parse(
                    fs.readFileSync(
                        studentsFile,
                        'utf8'
                    )
                );

            const targets =
                students.filter(
                    student =>
                        (
                            student.className ||
                            ''
                        )
                            .toString()
                            .trim() ===
                        className
                );

            if (!targets.length) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到此班級'
                });
            }

            const remainingStudents =
                students.filter(
                    student =>
                        (
                            student.className ||
                            ''
                        )
                            .toString()
                            .trim() !==
                        className
                );

            const timestamp =
                new Date()
                    .toISOString()
                    .replace(
                        /[:.]/g,
                        '-'
                    );

            const backupRoot =
                path.join(
                    __dirname,
                    'deleted-classes'
                );

            const classBackupDir =
                path.join(
                    backupRoot,
                    `${className}-${timestamp}`
                );

            fs.mkdirSync(
                classBackupDir,
                {recursive: true}
            );

            // 備份被刪除學生資料
            fs.writeFileSync(
                path.join(
                    classBackupDir,
                    'students.json'
                ),
                JSON.stringify(
                    targets,
                    null,
                    2
                )
            );

            // 移動學生作品資料夾
            let movedProjectFolders = 0;

            for (const student of targets) {
                const studentId =
                    (student.studentId || '')
                        .toString()
                        .trim();

                if (!studentId) {
                    continue;
                }

                const src =
                    path.join(
                        UPLOAD_DIR,
                        studentId
                    );

                const dst =
                    path.join(
                        classBackupDir,
                        studentId
                    );

                if (
                    fs.existsSync(src)
                ) {
                    fs.renameSync(
                        src,
                        dst
                    );

                    movedProjectFolders++;
                }
            }

            fs.writeFileSync(
                studentsFile,
                JSON.stringify(
                    remainingStudents,
                    null,
                    2
                )
            );

            // 從所有教師的 managedClasses 移除班級
            const teachers =
                readTeachers();

            let updatedTeachers = 0;

            for (const teacher of teachers) {
                if (
                    !Array.isArray(
                        teacher.managedClasses
                    )
                ) {
                    continue;
                }

                const before =
                    teacher.managedClasses.length;

                teacher.managedClasses =
                    teacher.managedClasses.filter(
                        item =>
                            item
                                .toString()
                                .trim() !==
                            className
                    );

                if (
                    teacher.managedClasses
                        .length !== before
                ) {
                    updatedTeachers++;
                }
            }

            writeTeachers(teachers);

            res.json({
                status: 'ok',
                className,
                removedStudents:
                    targets.length,
                movedProjectFolders,
                updatedTeachers,
                backupFolder:
                    classBackupDir
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '刪除班級失敗'
            });
        }
    }
);



// 管理者：列出已刪除班級備份
app.get(
    '/teacher/deleted-classes',
    requireTeacher,
    requireAdmin,
    (req, res) => {
        try {
            const backupRoot =
                path.join(
                    __dirname,
                    'deleted-classes'
                );

            if (!fs.existsSync(backupRoot)) {
                return res.json({
                    status: 'ok',
                    deletedClasses: []
                });
            }

            const items =
                fs.readdirSync(
                    backupRoot,
                    {
                        withFileTypes: true
                    }
                )
                .filter(item =>
                    item.isDirectory()
                )
                .map(item => {
                    const folder =
                        path.join(
                            backupRoot,
                            item.name
                        );

                    const studentsFile =
                        path.join(
                            folder,
                            'students.json'
                        );

                    let students = [];

                    if (
                        fs.existsSync(
                            studentsFile
                        )
                    ) {
                        try {
                            students =
                                JSON.parse(
                                    fs.readFileSync(
                                        studentsFile,
                                        'utf8'
                                    )
                                );
                        } catch {
                            students = [];
                        }
                    }

                    const firstStudent =
                        students[0] || {};

                    return {
                        folderName:
                            item.name,

                        className:
                            firstStudent.className ||
                            item.name.split('-')[0] ||
                            '',

                        studentCount:
                            students.length
                    };
                })
                .sort((a, b) =>
                    b.folderName.localeCompare(
                        a.folderName
                    )
                );

            res.json({
                status: 'ok',
                deletedClasses:
                    items
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '讀取已刪除班級失敗'
            });
        }
    }
);



// 管理者：還原已刪除班級
app.post(
    '/teacher/deleted-classes/:folderName/restore',
    requireTeacher,
    requireAdmin,
    express.json(),
    (req, res) => {
        try {
            const folderName =
                (req.params.folderName || '')
                    .toString()
                    .trim();

            if (!folderName) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少備份資料夾名稱'
                });
            }

            // 防止路徑穿越
            if (
                folderName.includes('/') ||
                folderName.includes('\\') ||
                folderName.includes('..')
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: '備份資料夾名稱不正確'
                });
            }

            const backupRoot =
                path.join(
                    __dirname,
                    'deleted-classes'
                );

            const backupDir =
                path.join(
                    backupRoot,
                    folderName
                );

            const studentsBackupFile =
                path.join(
                    backupDir,
                    'students.json'
                );

            if (
                !fs.existsSync(
                    studentsBackupFile
                )
            ) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到班級備份'
                });
            }

            const backupStudents =
                JSON.parse(
                    fs.readFileSync(
                        studentsBackupFile,
                        'utf8'
                    )
                );

            if (
                !Array.isArray(
                    backupStudents
                ) ||
                !backupStudents.length
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: '備份內沒有學生資料'
                });
            }

            const className =
                (
                    backupStudents[0]
                        .className ||
                    ''
                )
                    .toString()
                    .trim();

            const studentsFile =
                path.join(
                    __dirname,
                    'students.json'
                );

            const currentStudents =
                JSON.parse(
                    fs.readFileSync(
                        studentsFile,
                        'utf8'
                    )
                );

            const currentIds =
                new Set(
                    currentStudents.map(
                        student =>
                            student.studentId
                    )
                );

            const conflicts =
                backupStudents.filter(
                    student =>
                        currentIds.has(
                            student.studentId
                        )
                );

            if (conflicts.length) {
                return res.status(409).json({
                    status: 'error',
                    message:
                        '部分學生帳號已存在，無法直接還原',

                    conflicts:
                        conflicts.map(
                            student =>
                                student.studentId
                        )
                });
            }

            const mergedStudents = [
                ...currentStudents,
                ...backupStudents
            ];

            fs.writeFileSync(
                studentsFile,
                JSON.stringify(
                    mergedStudents,
                    null,
                    2
                )
            );

            let restoredProjectFolders = 0;

            for (
                const student of
                backupStudents
            ) {
                const studentId =
                    (student.studentId || '')
                        .toString()
                        .trim();

                if (!studentId) {
                    continue;
                }

                const src =
                    path.join(
                        backupDir,
                        studentId
                    );

                const dst =
                    path.join(
                        UPLOAD_DIR,
                        studentId
                    );

                if (
                    fs.existsSync(src) &&
                    !fs.existsSync(dst)
                ) {
                    fs.renameSync(
                        src,
                        dst
                    );

                    restoredProjectFolders++;
                }
            }


            // 還原成功後，把備份從 deleted-classes
            // 移到 restored-classes，避免繼續出現在待還原清單
            const restoredRoot =
                path.join(
                    __dirname,
                    'restored-classes'
                );

            fs.mkdirSync(
                restoredRoot,
                {recursive: true}
            );

            let restoredArchiveDir =
                path.join(
                    restoredRoot,
                    folderName
                );

            // 理論上 folderName 已含時間，不應重複；
            // 若真的存在，再補目前時間避免覆蓋。
            if (
                fs.existsSync(
                    restoredArchiveDir
                )
            ) {
                const suffix =
                    Date.now()
                        .toString();

                restoredArchiveDir =
                    path.join(
                        restoredRoot,
                        `${folderName}-${suffix}`
                    );
            }

            fs.renameSync(
                backupDir,
                restoredArchiveDir
            );

            res.json({
                status: 'ok',
                className,
                restoredStudents:
                    backupStudents.length,
                restoredProjectFolders,
                backupFolder:
                    folderName
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '還原班級失敗'
            });
        }
    }
);



// 公開：讀取網站顯示設定
app.get('/settings', (req, res) => {
    const settings =
        readSettings();

    res.json({
        status: 'ok',
        settings
    });
});


// 管理者：修改網站顯示設定
app.put(
    '/teacher/settings',
    requireTeacher,
    requireAdmin,
    express.json(),
    (req, res) => {
        const sitePrefix =
            (req.body.sitePrefix || '')
                .toString()
                .trim();

        if (!sitePrefix) {
            return res.status(400).json({
                status: 'error',
                message: '顯示名稱不可空白'
            });
        }

        if (sitePrefix.length > 30) {
            return res.status(400).json({
                status: 'error',
                message: '顯示名稱過長'
            });
        }

        const settings = {
            sitePrefix
        };

        writeSettings(settings);

        res.json({
            status: 'ok',
            settings
        });
    }
);



// 教師：修改自己的密碼
app.post(
    '/teacher/change-password',
    requireTeacher,
    express.json(),
    async (req, res) => {
        try {
            const currentPassword =
                (req.body.currentPassword || '')
                    .toString();

            const newPassword =
                (req.body.newPassword || '')
                    .toString();

            if (
                !currentPassword ||
                !newPassword
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: '請輸入目前密碼與新密碼'
                });
            }

            if (newPassword.length < 8) {
                return res.status(400).json({
                    status: 'error',
                    message: '新密碼至少需要 8 個字元'
                });
            }

            if (
                currentPassword ===
                newPassword
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: '新密碼不可與目前密碼相同'
                });
            }

            const username =
                (req.teacher.username || '')
                    .toString()
                    .trim();

            const teachers =
                readTeachers();

            const teacher =
                teachers.find(
                    item =>
                        item.username === username
                );

            if (!teacher) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到教師帳號'
                });
            }

            const valid =
                await bcrypt.compare(
                    currentPassword,
                    teacher.passwordHash || ''
                );

            if (!valid) {
                return res.status(403).json({
                    status: 'error',
                    message: '目前密碼錯誤'
                });
            }

            teacher.passwordHash =
                await bcrypt.hash(
                    newPassword,
                    10
                );

            writeTeachers(teachers);

            // 其他裝置上的同帳號登入全部失效
            for (
                const [token, session]
                of teacherSessions.entries()
            ) {
                if (
                    session.username === username &&
                    token !== req.teacherToken
                ) {
                    teacherSessions.delete(token);
                }
            }

            res.json({
                status: 'ok',
                message: '密碼修改成功'
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '修改密碼失敗'
            });
        }
    }
);


// 教師登出
app.post('/teacher/logout', (req, res) => {
    const auth = req.headers.authorization || '';

    if (auth.startsWith('Bearer ')) {
        teacherSessions.delete(auth.slice(7));
    }

    res.json({
        status: 'ok'
    });
});



// 教師：下載指定學生的 Scratch 作品
app.get(
    '/teacher/students/:studentId/projects/:projectId/file',
    requireTeacher,
    (req, res) => {
        try {
            const studentId = (req.params.studentId || '')
                .toString()
                .replace(/[^a-zA-Z0-9_-]/g, '_');

            const projectId = (req.params.projectId || '')
                .toString()
                .replace(/[^a-zA-Z0-9_-]/g, '');

            if (!studentId || !projectId) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少學生學號或作品 ID'
                });
            }

            const filePath = path.join(
                UPLOAD_DIR,
                studentId,
                `${projectId}.sb3`
            );

            if (!fs.existsSync(filePath)) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到作品'
                });
            }

            res.setHeader(
                'Content-Type',
                'application/octet-stream'
            );

            res.sendFile(filePath);

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '讀取作品檔案失敗'
            });
        }
    }
);

// 教師：取得指定學生的作品清單
app.get('/teacher/students/:id/projects', requireTeacher, (req, res) => {
    try {
        const studentId = (req.params.id || '')
            .toString()
            .replace(/[^a-zA-Z0-9_-]/g, '_');

        if (!studentId) {
            return res.status(400).json({
                status: 'error',
                message: '缺少學生學號'
            });
        }

        const studentDir = path.join(
            UPLOAD_DIR,
            studentId
        );

        if (!fs.existsSync(studentDir)) {
            return res.json({
                status: 'ok',
                studentId,
                projects: []
            });
        }

        const files = fs.readdirSync(studentDir)
            .filter(name =>
                name.endsWith('.meta.json')
            );

        const projects = files
            .map(file => {
                try {
                    return JSON.parse(
                        fs.readFileSync(
                            path.join(studentDir, file),
                            'utf8'
                        )
                    );
                } catch (err) {
                    return null;
                }
            })
            .filter(Boolean)
            .sort((a, b) => {
                const ta = new Date(
                    a.updatedAt ||
                    a.createdAt ||
                    0
                );

                const tb = new Date(
                    b.updatedAt ||
                    b.createdAt ||
                    0
                );

                return tb - ta;
            });

        res.json({
            status: 'ok',
            studentId,
            projects
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '讀取學生作品失敗'
        });
    }
});


// 教師：取得班級作品總覽
app.get(
    '/teacher/classes/:className/projects-summary',
    requireTeacher,
    requireManagedClass,
    (req, res) => {
        try {
            const className =
                (req.params.className || '')
                    .toString()
                    .trim();

            if (!className) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少班級'
                });
            }

            const studentsFile =
                path.join(__dirname, 'students.json');

            const students = JSON.parse(
                fs.readFileSync(studentsFile, 'utf8')
            );

            const classStudents =
                students.filter(student =>
                    (student.className || '') === className
                );

            if (!classStudents.length) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到這個班級的學生'
                });
            }

            const summary =
                classStudents.map(student => {
                    const studentDir =
                        path.join(
                            UPLOAD_DIR,
                            student.studentId
                        );

                    let projectCount = 0;
                    let latestAt = null;
                    let latestProjects = [];

                    if (fs.existsSync(studentDir)) {
                        const metaFiles =
                            fs.readdirSync(studentDir)
                                .filter(name =>
                                    name.endsWith('.meta.json')
                                );

                        const projects =
                            metaFiles
                                .map(file => {
                                    try {
                                        return JSON.parse(
                                            fs.readFileSync(
                                                path.join(
                                                    studentDir,
                                                    file
                                                ),
                                                'utf8'
                                            )
                                        );
                                    } catch (err) {
                                        return null;
                                    }
                                })
                                .filter(Boolean);

                        projects.sort((a, b) => {
                            const ta = new Date(
                                a.updatedAt ||
                                a.createdAt ||
                                0
                            );

                            const tb = new Date(
                                b.updatedAt ||
                                b.createdAt ||
                                0
                            );

                            return tb - ta;
                        });

                        projectCount =
                            projects.length;

                        if (projects.length > 0) {
                            latestAt =
                                projects[0].updatedAt ||
                                projects[0].createdAt ||
                                null;
                        }

                        latestProjects =
                            projects
                                .slice(0, 3)
                                .map(project => ({
                                    id: project.id,
                                    name:
                                        project.name ||
                                        '未命名作品',
                                    updatedAt:
                                        project.updatedAt ||
                                        project.createdAt ||
                                        null
                                }));
                    }

                    return {
                        studentId:
                            student.studentId,

                        name:
                            student.name || '',

                        className:
                            student.className || '',

                        seatNo:
                            student.seatNo || '',

                        active:
                            student.active !== false,

                        projectCount,

                        latestAt,

                        latestProjects
                    };
                })
                .sort((a, b) =>
                    String(a.seatNo || '')
                        .localeCompare(
                            String(b.seatNo || ''),
                            undefined,
                            {numeric: true}
                        )
                );

            res.json({
                status: 'ok',
                className,
                students: summary
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '讀取班級作品總覽失敗'
            });
        }
    }
);


// 教師：匯出班級作品總覽 Excel
app.get(
    '/teacher/classes/:className/projects.xlsx',
    requireTeacher,
    requireManagedClass,
    async (req, res) => {
        try {
            const className =
                (req.params.className || '')
                    .toString()
                    .trim();

            if (!className) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少班級'
                });
            }

            const studentsFile =
                path.join(__dirname, 'students.json');

            const students = JSON.parse(
                fs.readFileSync(studentsFile, 'utf8')
            );

            const classStudents =
                students
                    .filter(student =>
                        (student.className || '') === className
                    )
                    .sort((a, b) =>
                        String(a.seatNo || '')
                            .localeCompare(
                                String(b.seatNo || ''),
                                undefined,
                                {numeric: true}
                            )
                    );

            if (!classStudents.length) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到這個班級'
                });
            }

            const workbook =
                new ExcelJS.Workbook();

            const sheet =
                workbook.addWorksheet(
                    `${className}班作品總覽`
                );

            sheet.columns = [
                {header: '班級', key: 'className', width: 10},
                {header: '座號', key: 'seatNo', width: 8},
                {header: '學號', key: 'studentId', width: 14},
                {header: '姓名', key: 'name', width: 16},
                {header: '作品數', key: 'projectCount', width: 10},
                {header: '最新作品 1', key: 'project1', width: 24},
                {header: '最新作品 2', key: 'project2', width: 24},
                {header: '最新作品 3', key: 'project3', width: 24},
                {header: '最後更新', key: 'latestAt', width: 22}
            ];

            sheet.views = [
                {
                    state: 'frozen',
                    ySplit: 1
                }
            ];

            sheet.autoFilter = {
                from: 'A1',
                to: 'I1'
            };

            const baseUrl =
                `${req.protocol}://${req.hostname}`;

            for (const student of classStudents) {
                const studentDir =
                    path.join(
                        UPLOAD_DIR,
                        student.studentId
                    );

                let projects = [];

                if (fs.existsSync(studentDir)) {
                    const metaFiles =
                        fs.readdirSync(studentDir)
                            .filter(name =>
                                name.endsWith('.meta.json')
                            );

                    projects =
                        metaFiles
                            .map(file => {
                                try {
                                    return JSON.parse(
                                        fs.readFileSync(
                                            path.join(
                                                studentDir,
                                                file
                                            ),
                                            'utf8'
                                        )
                                    );
                                } catch {
                                    return null;
                                }
                            })
                            .filter(Boolean)
                            .sort((a, b) => {
                                const ta =
                                    new Date(
                                        a.updatedAt ||
                                        a.createdAt ||
                                        0
                                    );

                                const tb =
                                    new Date(
                                        b.updatedAt ||
                                        b.createdAt ||
                                        0
                                    );

                                return tb - ta;
                            });
                }

                const latestProjects =
                    projects.slice(0, 3);

                const latestAt =
                    latestProjects.length
                        ? (
                            latestProjects[0].updatedAt ||
                            latestProjects[0].createdAt ||
                            ''
                        )
                        : '';

                const row =
                    sheet.addRow({
                        className:
                            student.className || '',

                        seatNo:
                            student.seatNo || '',

                        studentId:
                            student.studentId,

                        name:
                            student.name || '',

                        projectCount:
                            projects.length,

                        latestAt:
                            latestAt
                                ? new Date(latestAt)
                                : ''
                    });

                latestProjects.forEach(
                    (project, index) => {
                        const col =
                            6 + index;

                        const projectName =
                            project.name ||
                            '未命名作品';

                        const url =
                            `${baseUrl}/teacher-view.html` +
                            `?studentId=${encodeURIComponent(student.studentId)}` +
                            `&projectId=${encodeURIComponent(project.id)}` +
                            `&name=${encodeURIComponent(projectName)}`;

                        row.getCell(col).value = {
                            text: projectName,
                            hyperlink: url
                        };
                    }
                );

                if (latestAt) {
                    row.getCell(9).numFmt =
                        'yyyy/mm/dd hh:mm';
                }
            }

            sheet.getRow(1).font = {
                bold: true
            };

            sheet.eachRow((row, rowNumber) => {
                row.alignment = {
                    vertical: 'middle',
                    wrapText: true
                };

                if (rowNumber > 1) {
                    row.height = 24;
                }
            });

            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            );

            res.setHeader(
                'Content-Disposition',
                `attachment; filename="class-${className}-projects.xlsx"`
            );

            await workbook.xlsx.write(res);
            res.end();

        } catch (error) {
            console.error(error);

            if (!res.headersSent) {
                res.status(500).json({
                    status: 'error',
                    message: 'Excel 匯出失敗'
                });
            }
        }
    }
);

// 教師：取得學生清單
app.get('/teacher/students', requireTeacher, (req, res) => {
    try {
        const studentsFile = path.join(__dirname, 'students.json');

        const students = JSON.parse(
            fs.readFileSync(studentsFile, 'utf8')
        );

        const managedClasses =
            Array.isArray(req.teacher.managedClasses)
                ? req.teacher.managedClasses
                : [];

        const visibleStudents =
            managedClasses.includes('*')
                ? students
                : students.filter(student =>
                    canManageClass(
                        req.teacher,
                        student.className || ''
                    )
                );

        const safeStudents = visibleStudents.map(student => ({
            studentId: student.studentId,
            name: student.name || '',
            className: student.className || '',
            seatNo: student.seatNo || '',
            active: student.active !== false
        }));

        res.json({
            status: 'ok',
            students: safeStudents
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '讀取學生清單失敗'
        });
    }
});



// 教師：啟用 / 停用學生帳號
app.post('/teacher/students/:id/active', requireTeacher, express.json(), (req, res) => {
    try {
        const studentId = (req.params.id || '').toString().trim();
        const active = req.body.active;

        if (typeof active !== 'boolean') {
            return res.status(400).json({
                status: 'error',
                message: 'active 必須是 true 或 false'
            });
        }

        const studentsFile = path.join(__dirname, 'students.json');

        const students = JSON.parse(
            fs.readFileSync(studentsFile, 'utf8')
        );

        const student = students.find(
            item => item.studentId === studentId
        );

        if (!student) {
            return res.status(404).json({
                status: 'error',
                message: '找不到學生'
            });
        }

        if (
            !canManageClass(
                req.teacher,
                student.className || ''
            )
        ) {
            return res.status(403).json({
                status: 'error',
                message: '沒有管理此學生所屬班級的權限'
            });
        }

        student.active = active;

        fs.writeFileSync(
            studentsFile,
            JSON.stringify(students, null, 2)
        );

        res.json({
            status: 'ok',
            student: {
                studentId: student.studentId,
                name: student.name || '',
                active: student.active
            }
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '更新帳號狀態失敗'
        });
    }
});


// 教師：批次匯入學生帳號
app.post(
    '/teacher/students/import',
    requireTeacher,
    express.json({limit: '2mb'}),
    async (req, res) => {
        try {
            const rows = Array.isArray(req.body.rows)
                ? req.body.rows
                : [];

            if (!rows.length) {
                return res.status(400).json({
                    status: 'error',
                    message: '沒有可匯入的學生資料'
                });
            }

            const studentsFile =
                path.join(__dirname, 'students.json');

            const students = JSON.parse(
                fs.readFileSync(studentsFile, 'utf8')
            );

            const byId = new Map(
                students.map(student => [
                    student.studentId,
                    student
                ])
            );

            let added = 0;
            let updated = 0;
            let skipped = 0;

            const errors = [];

            for (let i = 0; i < rows.length; i++) {
                const row = rows[i] || {};

                const studentId =
                    (row.studentId || '')
                        .toString()
                        .trim();

                const name =
                    (row.name || '')
                        .toString()
                        .trim();

                const className =
                    (row.className || '')
                        .toString()
                        .trim();

                const seatNo =
                    (row.seatNo || '')
                        .toString()
                        .trim();

                const password =
                    (row.password || '')
                        .toString();

                // CSV_TARGET_CLASS_PERMISSION
                // 只能匯入自己有管理權限的班級
                if (
                    !canManageClass(
                        req.teacher,
                        className
                    )
                ) {
                    skipped++;

                    errors.push(
                        `第 ${i + 2} 列：沒有管理 ${className || '未指定'} 班的權限`
                    );

                    continue;
                }


                if (!studentId) {
                    skipped++;
                    errors.push(
                        `第 ${i + 2} 列：缺少學號`
                    );
                    continue;
                }

                if (!/^[a-zA-Z0-9_-]+$/.test(studentId)) {
                    skipped++;
                    errors.push(
                        `第 ${i + 2} 列：學號格式不合法 (${studentId})`
                    );
                    continue;
                }

                const existing =
                    byId.get(studentId);

                if (
                    existing &&
                    !canManageClass(
                        req.teacher,
                        existing.className || ''
                    )
                ) {
                    skipped++;

                    errors.push(
                        `第 ${i + 2} 列：學生 ${studentId} 原班級 ${existing.className || '未指定'}：沒有管理權限`
                    );

                    continue;
                }

                
                // CSV_EXISTING_CLASS_PERMISSION
                // 既有學生也必須有原班級管理權限
                if (
                    existing &&
                    !canManageClass(
                        req.teacher,
                        existing.className || ''
                    )
                ) {
                    skipped++;

                    errors.push(
                        `第 ${i + 2} 列：沒有管理學生 ${studentId} 原班級的權限`
                    );

                    continue;
                }

if (existing) {
                    existing.name = name;
                    existing.className = className;
                    existing.seatNo = seatNo;

                    if (password) {
                        existing.passwordHash =
                            await bcrypt.hash(
                                password,
                                10
                            );
                    }

                    if (
                        typeof existing.active
                        !== 'boolean'
                    ) {
                        existing.active = true;
                    }

                    updated++;

                } else {
                    if (!password) {
                        skipped++;
                        errors.push(
                            `第 ${i + 2} 列：新學生缺少密碼 (${studentId})`
                        );
                        continue;
                    }

                    const newStudent = {
                        studentId,
                        name,
                        className,
                        seatNo,
                        passwordHash:
                            await bcrypt.hash(
                                password,
                                10
                            ),
                        active: true
                    };

                    byId.set(
                        studentId,
                        newStudent
                    );

                    added++;
                }
            }

            const finalStudents =
                Array.from(byId.values())
                    .sort((a, b) =>
                        a.studentId.localeCompare(
                            b.studentId,
                            undefined,
                            {numeric: true}
                        )
                    );

            fs.writeFileSync(
                studentsFile,
                JSON.stringify(
                    finalStudents,
                    null,
                    2
                )
            );

            res.json({
                status: 'ok',
                added,
                updated,
                skipped,
                total: finalStudents.length,
                errors
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '批次匯入失敗'
            });
        }
    }
);


// 教師：依班級與人數快速建立整班帳號
app.post(
    '/teacher/classes/create',
    requireTeacher,
    requireManagedClass,
    express.json(),
    async (req, res) => {
        try {
            const className =
                (req.body.className || '')
                    .toString()
                    .trim();

            const count =
                Number(req.body.count);

            if (!className) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少班級'
                });
            }

            if (
                !Number.isInteger(count) ||
                count < 1 ||
                count > 60
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: '學生人數必須是 1～60'
                });
            }

            const studentsFile =
                path.join(__dirname, 'students.json');

            const students = JSON.parse(
                fs.readFileSync(studentsFile, 'utf8')
            );

            const byId = new Map(
                students.map(student => [
                    student.studentId,
                    student
                ])
            );

            let added = 0;
            let skipped = 0;

            const created = [];

            for (
                let seat = 1;
                seat <= count;
                seat++
            ) {
                const seatNo =
                    String(seat).padStart(2, '0');

                const studentId =
                    `${className}${seatNo}`;

                if (byId.has(studentId)) {
                    skipped++;
                    continue;
                }

                const passwordHash =
                    await bcrypt.hash(
                        studentId,
                        10
                    );

                const student = {
                    studentId,
                    name: '',
                    className,
                    seatNo,
                    passwordHash,
                    active: true
                };

                byId.set(
                    studentId,
                    student
                );

                created.push({
                    studentId,
                    className,
                    seatNo
                });

                added++;
            }

            const finalStudents =
                Array.from(byId.values())
                    .sort((a, b) =>
                        a.studentId.localeCompare(
                            b.studentId,
                            undefined,
                            {numeric: true}
                        )
                    );

            fs.writeFileSync(
                studentsFile,
                JSON.stringify(
                    finalStudents,
                    null,
                    2
                )
            );

            res.json({
                status: 'ok',
                className,
                requested: count,
                added,
                skipped,
                total: finalStudents.length,
                created
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '建立整班帳號失敗'
            });
        }
    }
);


// 教師：整班重設預設密碼
app.post(
    '/teacher/classes/:className/reset-passwords',
    requireTeacher,
    requireManagedClass,
    async (req, res) => {
        try {
            const className =
                (req.params.className || '')
                    .toString()
                    .trim();

            if (!className) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少班級'
                });
            }

            const studentsFile =
                path.join(__dirname, 'students.json');

            const students = JSON.parse(
                fs.readFileSync(studentsFile, 'utf8')
            );

            let resetCount = 0;

            for (const student of students) {
                if (
                    (student.className || '') !== className
                ) {
                    continue;
                }

                student.passwordHash =
                    await bcrypt.hash(
                        student.studentId,
                        10
                    );

                resetCount++;
            }

            if (resetCount === 0) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到這個班級的學生'
                });
            }

            fs.writeFileSync(
                studentsFile,
                JSON.stringify(
                    students,
                    null,
                    2
                )
            );

            res.json({
                status: 'ok',
                className,
                resetCount
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '整班重設密碼失敗'
            });
        }
    }
);


// 教師：整班啟用 / 停用
app.post(
    '/teacher/classes/:className/active',
    requireTeacher,
    requireManagedClass,
    express.json(),
    (req, res) => {
        try {
            const className =
                (req.params.className || '')
                    .toString()
                    .trim();

            const active =
                req.body.active;

            if (!className) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少班級'
                });
            }

            if (typeof active !== 'boolean') {
                return res.status(400).json({
                    status: 'error',
                    message: 'active 必須是 true 或 false'
                });
            }

            const studentsFile =
                path.join(__dirname, 'students.json');

            const students = JSON.parse(
                fs.readFileSync(studentsFile, 'utf8')
            );

            let changedCount = 0;

            for (const student of students) {
                if (
                    (student.className || '') !== className
                ) {
                    continue;
                }

                student.active = active;
                changedCount++;
            }

            if (changedCount === 0) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到這個班級的學生'
                });
            }

            fs.writeFileSync(
                studentsFile,
                JSON.stringify(
                    students,
                    null,
                    2
                )
            );

            res.json({
                status: 'ok',
                className,
                active,
                changedCount
            });

        } catch (error) {
            console.error(error);

            res.status(500).json({
                status: 'error',
                message: '整班帳號狀態更新失敗'
            });
        }
    }
);

// 教師：新增或更新學生帳號
app.post('/teacher/students', requireTeacher, express.json(), async (req, res) => {
    try {
        const studentId = (req.body.studentId || '').toString().trim();
        const name = (req.body.name || '').toString().trim();
        const className = (req.body.className || '').toString().trim();

        if (
            !canManageClass(
                req.teacher,
                className
            )
        ) {
            return res.status(403).json({
                status: 'error',
                message: '沒有管理此班級的權限'
            });
        }
        const seatNo = (req.body.seatNo || '').toString().trim();
        const password = (req.body.password || '').toString();

        if (!studentId) {
            return res.status(400).json({
                status: 'error',
                message: '缺少學號'
            });
        }

        if (!/^[a-zA-Z0-9_-]+$/.test(studentId)) {
            return res.status(400).json({
                status: 'error',
                message: '學號格式不合法'
            });
        }

        const studentsFile = path.join(__dirname, 'students.json');

        const students = JSON.parse(
            fs.readFileSync(studentsFile, 'utf8')
        );

        let student = students.find(
            item => item.studentId === studentId
        );

        if (
            student &&
            !canManageClass(
                req.teacher,
                student.className || ''
            )
        ) {
            return res.status(403).json({
                status: 'error',
                message: '沒有管理此學生原班級的權限'
            });
        }

        if (student) {
            student.name = name;
            student.className = className;
            student.seatNo = seatNo;

            if (password) {
                student.passwordHash =
                    await bcrypt.hash(password, 10);
            }

        } else {
            if (!password) {
                return res.status(400).json({
                    status: 'error',
                    message: '新學生必須設定密碼'
                });
            }

            student = {
                studentId,
                name,
                className,
                seatNo,
                passwordHash:
                    await bcrypt.hash(password, 10)
            };

            students.push(student);
        }

        fs.writeFileSync(
            studentsFile,
            JSON.stringify(students, null, 2)
        );

        res.json({
            status: 'ok',
            student: {
                studentId: student.studentId,
                name: student.name || ''
            }
        });

    } catch (error) {
        console.error(error);

        res.status(500).json({
            status: 'error',
            message: '儲存學生帳號失敗'
        });
    }
});

// 上傳 Scratch .sb3 檔案
app.post('/projects/upload', requireAuth, upload.single('file'), (req, res) => {
  try {
        const studentId = req.studentId;

        const studentDir = path.join(UPLOAD_DIR, studentId);

        if (!fs.existsSync(studentDir)) {
            fs.mkdirSync(studentDir, {recursive: true});
        }

    if (!req.file) {
      return res.status(400).json({
        status: 'error',
        message: '沒有收到檔案'
      });
    }

    const id = crypto.randomUUID();
    const projectName = req.body.name || req.file.originalname || '未命名作品';

    const finalFileName = `${id}.sb3`;
    const finalPath = path.join(studentDir, finalFileName);

    fs.renameSync(req.file.path, finalPath);

    const metadata = {
      id,
        studentId: studentId,
      name: projectName,
      filename: finalFileName,
      originalName: req.file.originalname,
      size: req.file.size,
      createdAt: new Date().toISOString()
    };

    fs.writeFileSync(
      path.join(studentDir, `${id}.meta.json`),
      JSON.stringify(metadata, null, 2),
      'utf8'
    );

    res.status(201).json({
      status: 'uploaded',
      id,
      name: projectName,
      size: req.file.size
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: 'error',
      message: '上傳作品失敗'
    });
  }
});

// 下載 Scratch .sb3 檔案
app.get('/projects/:id/download', (req, res) => {
  try {
    const metaPath = path.join(DATA_DIR, `${req.params.id}.meta.json`);

    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({
        status: 'error',
        message: '找不到作品'
      });
    }

    const metadata = JSON.parse(
      fs.readFileSync(metaPath, 'utf8')
    );

    const filePath = path.join(
      UPLOAD_DIR,
      metadata.filename
    );

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        status: 'error',
        message: '作品檔案不存在'
      });
    }

    res.download(
      filePath,
      metadata.originalName || `${metadata.id}.sb3`
    );

  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: 'error',
      message: '下載作品失敗'
    });
  }
});



// ==============================
// 教師設定學生 Google 帳號綁定
// ==============================

// 讀取學生 Google 帳號綁定
app.get(
    '/teacher/students/:studentId/google',
    requireTeacher,
    async (req, res) => {
        try {
            const studentId =
                (req.params.studentId || '')
                    .toString()
                    .trim();

            const studentsFile =
                path.join(
                    __dirname,
                    'students.json'
                );

            const students =
                JSON.parse(
                    fs.readFileSync(
                        studentsFile,
                        'utf8'
                    )
                );

            const student =
                students.find(
                    item =>
                        item.studentId === studentId
                );

            if (!student) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到學生帳號'
                });
            }

            if (
                !canManageClass(
                    req.teacher,
                    student.className
                )
            ) {
                return res.status(403).json({
                    status: 'error',
                    message: '沒有權限管理此學生'
                });
            }

            return res.json({
                status: 'ok',
                studentId:
                    student.studentId,
                googleEmail:
                    student.googleEmail || '',
                linked:
                    Boolean(
                        student.googleEmail
                    ),
                googleVerified:
                    Boolean(
                        student.googleSub
                    )
            });

        } catch (error) {
            console.error(
                '[TEACHER] Google binding read error',
                error
            );

            return res.status(500).json({
                status: 'error',
                message: '讀取 Google 綁定失敗'
            });
        }
    }
);


app.put(
    '/teacher/students/:studentId/google',
    requireTeacher,
    express.json(),
    async (req, res) => {
        try {
            const studentId =
                (req.params.studentId || '')
                    .toString()
                    .trim();

            const googleEmail =
                (req.body.googleEmail || '')
                    .toString()
                    .trim()
                    .toLowerCase();

            if (!studentId) {
                return res.status(400).json({
                    status: 'error',
                    message: '缺少學生帳號'
                });
            }

            if (
                googleEmail &&
                !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
                    googleEmail
                )
            ) {
                return res.status(400).json({
                    status: 'error',
                    message: 'Google Email 格式不正確'
                });
            }

            const studentsFile =
                path.join(
                    __dirname,
                    'students.json'
                );

            const students =
                JSON.parse(
                    fs.readFileSync(
                        studentsFile,
                        'utf8'
                    )
                );

            const student =
                students.find(
                    item =>
                        item.studentId === studentId
                );

            if (!student) {
                return res.status(404).json({
                    status: 'error',
                    message: '找不到學生帳號'
                });
            }

            if (
                !canManageClass(
                    req.teacher,
                    student.className
                )
            ) {
                return res.status(403).json({
                    status: 'error',
                    message: '沒有權限管理此學生'
                });
            }

            if (googleEmail) {
                const duplicate =
                    students.find(item =>
                        item.studentId !== studentId &&
                        (item.googleEmail || '')
                            .toString()
                            .trim()
                            .toLowerCase() ===
                            googleEmail
                    );

                if (duplicate) {
                    return res.status(409).json({
                        status: 'error',
                        message:
                            `此 Google Email 已綁定學生 ${duplicate.studentId}`
                    });
                }
            }

            const oldEmail =
                (student.googleEmail || '')
                    .toString()
                    .trim()
                    .toLowerCase();

            student.googleEmail =
                googleEmail;

            // Email 改變或解除綁定時，
            // 清除舊 Google sub，
            // 下一次 Google 登入重新建立。
            if (oldEmail !== googleEmail) {
                student.googleSub = '';
            }

            fs.writeFileSync(
                studentsFile,
                JSON.stringify(
                    students,
                    null,
                    2
                ),
                'utf8'
            );

            return res.json({
                status: 'ok',
                studentId:
                    student.studentId,
                googleEmail:
                    student.googleEmail || '',
                linked:
                    Boolean(student.googleEmail)
            });

        } catch (error) {
            console.error(
                '[TEACHER] Google binding error',
                error
            );

            return res.status(500).json({
                status: 'error',
                message: 'Google 帳號綁定失敗'
            });
        }
    }
);


app.listen(PORT, '0.0.0.0', () => {
  console.log(`Scratch API listening on port ${PORT}`);
});
