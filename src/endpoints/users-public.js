import crypto from 'node:crypto';

import storage from 'node-persist';
import express from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { getIpFromRequest, getRealIpFromHeader } from '../express-common.js';
import { color, Cache, getConfigValue } from '../util.js';
import { KEY_PREFIX, getUserAvatar, toKey, getPasswordHash, getPasswordSalt, getAllUserHandles, getUserDirectories, ensurePublicDirectoriesExist } from '../users.js';
import { validateInvitationCode, useInvitationCode } from '../invitation-codes.js';
import { checkForNewContent, CONTENT_TYPES } from './content-manager.js';
import systemMonitor from '../system-monitor.js';
import lodash from 'lodash';

const DISCREET_LOGIN = getConfigValue('enableDiscreetLogin', false, 'boolean');
const PREFER_REAL_IP_HEADER = getConfigValue('rateLimiting.preferRealIpHeader', false, 'boolean');
const MFA_CACHE = new Cache(5 * 60 * 1000);

const getIpAddress = (request) => PREFER_REAL_IP_HEADER ? getRealIpFromHeader(request) : getIpFromRequest(request);

export const router = express.Router();
const loginLimiter = new RateLimiterMemory({
    points: 5,
    duration: 60,
});
const recoverLimiter = new RateLimiterMemory({
    points: 5,
    duration: 300,
});
const registerLimiter = new RateLimiterMemory({
    points: 3,
    duration: 300,
});

/**
 * 判断用户名是否过于随意/简单，不允许注册。
 * 规则：
 * - 纯数字且长度>=3
 * - 单字符重复3次及以上（如 aaa, 1111）
 * - 常见随意/弱用户名列表
 */
function isTrivialHandle(handle) {
	if (!handle) return true;
	const h = String(handle).toLowerCase();
	// 纯数字，长度>=3
	if (/^\d{3,}$/.test(h)) return true;
	// 单字符重复3次及以上
	if (/^(.)\1{2,}$/.test(h)) return true;
	// 常见随意用户名/弱用户名集合
	const banned = new Set([
		'123', '1234', '12345', '123456', '000', '0000', '111', '1111',
		'qwe', 'qwer', 'qwert', 'qwerty', 'asdf', 'zxc', 'zxcv', 'zxcvb', 'qaz', 'qazwsx',
		'test', 'tester', 'testing', 'guest', 'user', 'username', 'admin', 'root', 'null', 'void',
		'abc', 'abcd', 'abcdef'
	]);
	if (banned.has(h)) return true;
	return false;
}

router.post('/list', async (_request, response) => {
    try {
        if (DISCREET_LOGIN) {
            return response.sendStatus(204);
        }

        /** @type {import('../users.js').User[]} */
        const users = await storage.values(x => x.key.startsWith(KEY_PREFIX));

        /** @type {Promise<import('../users.js').UserViewModel>[]} */
        const viewModelPromises = users
            .filter(x => x.enabled)
            .map(user => new Promise(async (resolve) => {
                getUserAvatar(user.handle).then(avatar =>
                    resolve({
                        handle: user.handle,
                        name: user.name,
                        created: user.created,
                        avatar: avatar,
                        password: !!user.password,
                    }),
                );
            }));

        const viewModels = await Promise.all(viewModelPromises);
        viewModels.sort((x, y) => (x.created ?? 0) - (y.created ?? 0));
        return response.json(viewModels);
    } catch (error) {
        console.error('User list failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/login', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Login failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const ip = getIpAddress(request);
        await loginLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Login failed: User', request.body.handle, 'not found');
            return response.status(403).json({ error: 'Incorrect credentials' });
        }

        if (!user.enabled) {
            console.warn('Login failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        if (user.password && user.password !== getPasswordHash(request.body.password, user.salt)) {
            console.warn('Login failed: Incorrect password for', user.handle);
            return response.status(403).json({ error: 'Incorrect credentials' });
        }

        if (!request.session) {
            console.error('Session not available');
            return response.sendStatus(500);
        }

        await loginLimiter.delete(ip);
        request.session.handle = user.handle;

        // 记录用户登录到系统监控器
        systemMonitor.recordUserLogin(user.handle, { userName: user.name });

        console.info('Login successful:', user.handle, 'from', ip, 'at', new Date().toLocaleString());
        return response.json({ handle: user.handle });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Login failed: Rate limited from', getIpAddress(request));
            return response.status(429).send({ error: 'Too many attempts. Try again later or recover your password.' });
        }

        console.error('Login failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/logout', async (request, response) => {
    try {
        if (!request.session) {
            return response.sendStatus(200);
        }

        const userHandle = request.session.handle;
        if (userHandle) {
            // 记录用户登出到系统监控器
            systemMonitor.recordUserLogout(userHandle);
            console.info('Logout successful:', userHandle, 'at', new Date().toLocaleString());
        }

        // 清除会话
        request.session = null;
        return response.sendStatus(200);
    } catch (error) {
        console.error('Logout failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/heartbeat', async (request, response) => {
    try {
        if (!request.session || !request.session.handle) {
            return response.status(401).json({ error: 'Not authenticated' });
        }

        const userHandle = request.session.handle;
        const user = await storage.getItem(toKey(userHandle));

        if (!user) {
            return response.status(401).json({ error: 'User not found' });
        }

        // 更新用户活动状态
        systemMonitor.updateUserActivity(userHandle, {
            userName: user.name,
            isHeartbeat: true
        });

        // 更新session的最后活动时间
        request.session.lastActivity = Date.now();

        return response.json({ status: 'ok', timestamp: Date.now() });
    } catch (error) {
        console.error('Heartbeat failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step1', async (request, response) => {
    try {
        if (!request.body.handle) {
            console.warn('Recover step 1 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        const ip = getIpAddress(request);
        await recoverLimiter.consume(ip);

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));

        if (!user) {
            console.error('Recover step 1 failed: User', request.body.handle, 'not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            console.error('Recover step 1 failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        const mfaCode = String(crypto.randomInt(1000, 9999));
        console.log();
        console.log(color.blue(`${user.name}, your password recovery code is: `) + color.magenta(mfaCode));
        console.log();
        MFA_CACHE.set(user.handle, mfaCode);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Recover step 1 failed: Rate limited from', getIpAddress(request));
            return response.status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        console.error('Recover step 1 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/recover-step2', async (request, response) => {
    try {
        if (!request.body.handle || !request.body.code) {
            console.warn('Recover step 2 failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        /** @type {import('../users.js').User} */
        const user = await storage.getItem(toKey(request.body.handle));
        const ip = getIpAddress(request);

        if (!user) {
            console.error('Recover step 2 failed: User', request.body.handle, 'not found');
            return response.status(404).json({ error: 'User not found' });
        }

        if (!user.enabled) {
            console.warn('Recover step 2 failed: User', user.handle, 'is disabled');
            return response.status(403).json({ error: 'User is disabled' });
        }

        const mfaCode = MFA_CACHE.get(user.handle);

        if (request.body.code !== mfaCode) {
            await recoverLimiter.consume(ip);
            console.warn('Recover step 2 failed: Incorrect code');
            return response.status(403).json({ error: 'Incorrect code' });
        }

        if (request.body.newPassword) {
            const salt = getPasswordSalt();
            user.password = getPasswordHash(request.body.newPassword, salt);
            user.salt = salt;
            await storage.setItem(toKey(user.handle), user);
        } else {
            user.password = '';
            user.salt = '';
            await storage.setItem(toKey(user.handle), user);
        }

        await recoverLimiter.delete(ip);
        MFA_CACHE.remove(user.handle);
        return response.sendStatus(204);
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Recover step 2 failed: Rate limited from', getIpAddress(request));
            return response.status(429).send({ error: 'Too many attempts. Try again later or contact your admin.' });
        }

        console.error('Recover step 2 failed:', error);
        return response.sendStatus(500);
    }
});

router.post('/register', async (request, response) => {
    try {
        const { handle, name, password, confirmPassword, invitationCode } = request.body;

        if (!handle || !name || !password || !confirmPassword) {
            console.warn('Register failed: Missing required fields');
            return response.status(400).json({ error: 'Missing required fields' });
        }

        if (password !== confirmPassword) {
            console.warn('Register failed: Password mismatch');
            return response.status(400).json({ error: 'Passwords do not match' });
        }

        if (password.length < 6) {
            console.warn('Register failed: Password too short');
            return response.status(400).json({ error: 'Password must be at least 6 characters long' });
        }

        const ip = getIpAddress(request);
        await registerLimiter.consume(ip);

        // 验证邀请码（如果启用）
        const invitationValidation = await validateInvitationCode(invitationCode);
        if (!invitationValidation.valid) {
            console.warn('Register failed: Invalid invitation code');
            return response.status(400).json({ error: invitationValidation.reason || 'Invalid invitation code' });
        }

        const handles = await getAllUserHandles();
        const normalizedHandle = lodash.kebabCase(String(handle).toLowerCase().trim());

        if (!normalizedHandle) {
            console.warn('Register failed: Invalid handle');
            return response.status(400).json({ error: 'Invalid handle' });
        }

		// 验证用户名只包含字母和数字，不允许任何符号
		if (!/^[a-z0-9]+$/.test(normalizedHandle)) {
			console.warn('Register failed: Handle contains invalid characters:', normalizedHandle);
			return response.status(400).json({ error: 'Username can only contain letters and numbers, no symbols allowed.' });
		}

		// 限制随意/弱用户名
		if (isTrivialHandle(normalizedHandle)) {
			console.warn('Register failed: Trivial/weak handle not allowed:', normalizedHandle);
			return response.status(400).json({ error: 'Handle is too simple. Please choose a more unique username.' });
		}

        if (handles.some(x => x === normalizedHandle)) {
            console.warn('Register failed: User with that handle already exists');
            return response.status(409).json({ error: 'User already exists' });
        }

        const salt = getPasswordSalt();
        const hashedPassword = getPasswordHash(password, salt);

        const newUser = {
            handle: normalizedHandle,
            name: name.trim(),
            created: Date.now(),
            password: hashedPassword,
            salt: salt,
            admin: false,
            enabled: true,
        };

        await storage.setItem(toKey(normalizedHandle), newUser);

        // 使用邀请码（如果提供）
        if (invitationCode) {
            await useInvitationCode(invitationCode, normalizedHandle);
        }

        // Create user directories
        console.info('Creating data directories for', newUser.handle);
        await ensurePublicDirectoriesExist();
        const directories = getUserDirectories(newUser.handle);
        await checkForNewContent([directories], [CONTENT_TYPES.SETTINGS]);

        await registerLimiter.delete(ip);
        console.info('User registered successfully:', newUser.handle, 'from', ip);
        return response.json({ handle: newUser.handle });
    } catch (error) {
        if (error instanceof RateLimiterRes) {
            console.error('Register failed: Rate limited from', getIpAddress(request));
            return response.status(429).send({ error: 'Too many attempts. Try again later.' });
        }

        console.error('Register failed:', error);
        return response.sendStatus(500);
    }
});

// 获取当前用户信息
router.get('/me', async (request, response) => {
    try {
        if (!request.session || !request.session.handle) {
            return response.status(401).json({ error: 'Not authenticated' });
        }

        const userHandle = request.session.handle;
        const user = await storage.getItem(toKey(userHandle));

        if (!user) {
            return response.status(401).json({ error: 'User not found' });
        }

        // 返回用户基本信息
        return response.json({
            handle: user.handle,
            name: user.name,
            admin: user.admin || false,
            enabled: user.enabled
        });
    } catch (error) {
        console.error('Get current user failed:', error);
        return response.sendStatus(500);
    }
});
