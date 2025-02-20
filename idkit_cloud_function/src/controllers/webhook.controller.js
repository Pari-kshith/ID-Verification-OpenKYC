const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');
const crypto = require('crypto');
const axios = require('axios');

class WebhookController {
    constructor(settings = {}) {
        this.settings = {
            webhook_enabled: false,
            webhook_url: '',
            webhook_secret: '',
            ...settings
        };
    }

    /**
     * Handles callable function requests for webhook testing
     * @param {Object} data - The request data
     * @param {Object} context - The function context
     * @returns {Promise<Object>} The webhook test response
     */
    async handleCallableWebhookTest(data, context) {
        try {
            const response = await this.executeWebhookTest(data);
            return this.formatSuccessResponse(response);
        } catch (error) {
            console.error('Webhook test error:', error);
            throw this.formatErrorResponse(error);
        }
    }

    /**
     * Executes the webhook test with provided data
     * @private
     */
    async executeWebhookTest(data) {
        if (!this.settings.webhook_enabled) {
            throw new Error('Webhooks are not enabled in settings');
        }

        if (!this.settings.webhook_url) {
            throw new Error('Webhook URL is not configured');
        }

        if (!this.settings.webhook_secret) {
            throw new Error('Webhook secret is not configured');
        }

        const testId = this.generateTestId();
        const webhookPayload = this.createWebhookPayload(testId);

        try {
            const response = await this.sendWebhookRequest(webhookPayload);
            await this.logWebhookAttempt({
                testId,
                status: this.isSuccessStatus(response.status) ? 'success' : 'failed',
                responseStatus: response.status
            });

            return {
                testId,
                status: response.status,
                success: this.isSuccessStatus(response.status),
                message: this.isSuccessStatus(response.status)
                    ? 'Test webhook sent successfully'
                    : this.getErrorMessage(response.status)
            };
        } catch (error) {
            const errorDetails = this.handleNetworkError(error);
            await this.logWebhookAttempt({
                testId,
                status: 'failed',
                error: errorDetails.message,
                errorCode: errorDetails.code
            });
            throw error;
        }
    }

    /**
     * Creates the webhook test payload
     * @private
     */
    createWebhookPayload(testId) {
        return {
            event: 'webhook.test',
            timestamp: Date.now(),
            data: {
                message: 'Test notification',
                test_id: testId
            }
        };
    }

    /**
     * Sends the webhook request
     * @private
     */
    async sendWebhookRequest(payload) {
        try {
            new URL(this.settings.webhook_url);
        } catch {
            throw new Error('Invalid webhook URL format');
        }

        return axios.post(
            this.settings.webhook_url,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'X-Webhook-Signature': this.generateSignature(payload),
                    'X-Webhook-Event': 'webhook.test'
                },
                timeout: 5000,
                validateStatus: null
            }
        );
    }

    /**
     * Formats the success response
     * @private
     */
    formatSuccessResponse(responseData) {
        return {
            success: responseData.success,
            message: responseData.message,
            details: {
                test_id: responseData.testId,
                response_status: responseData.status
            },
            statusCode: responseData.status
        };
    }

    /**
     * Formats the error response
     * @private
     */
    formatErrorResponse(error) {
        return new HttpsError(
            'internal',
            error.message || 'Failed to test webhook',
            {
                details: error.details || {},
                errorCode: error.code
            }
        );
    }

    /**
     * Generates a unique test ID
     * @private
     */
    generateTestId() {
        return crypto.randomBytes(8).toString('hex');
    }

    /**
     * Checks if the status code indicates success
     * @private
     */
    isSuccessStatus(status) {
        return status >= 200 && status < 300;
    }

    generateSignature(payload) {
        const jsonPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
        return crypto
            .createHmac('sha256', this.settings.webhook_secret)
            .update(jsonPayload)
            .digest('hex');
    }

    async testWebhook(req, res) {
        const testId = crypto.randomBytes(8).toString('hex');

        try {
            // Basic validations
            if (req.method !== 'POST') {
                throw new Error('Method not allowed');
            }

            if (!this.settings.webhook_enabled) {
                throw new Error('Webhooks are not enabled in settings');
            }

            if (!this.settings.webhook_url) {
                throw new Error('Webhook URL is not configured');
            }

            if (!this.settings.webhook_secret) {
                throw new Error('Webhook secret is not configured');
            }

            try {
                new URL(this.settings.webhook_url);
            } catch {
                throw new Error('Invalid webhook URL format');
            }

            // Prepare test payload
            const payload = {
                event: 'webhook.test',
                timestamp: Date.now(),
                data: {
                    message: 'Test notification',
                    test_id: testId
                }
            };

            // Send webhook request
            const response = await axios.post(
                this.settings.webhook_url,
                payload,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Webhook-Signature': this.generateSignature(payload),
                        'X-Webhook-Event': 'webhook.test'
                    },
                    timeout: 5000,
                    validateStatus: null
                }
            );

            // Log the attempt
            const logResult = await this.logWebhookAttempt({
                testId,
                status: response.status >= 200 && response.status < 300 ? 'success' : 'failed',
                responseStatus: response.status
            });

            // Return success response if HTTP status is 2xx
            if (response.status >= 200 && response.status < 300) {

                console.log('Sending webhook response:', {
                    success: true,
                    message: 'Test webhook sent successfully',
                    details: {
                        test_id: testId,
                        response_status: response.status
                    }
                });

                return res.status(200).json({
                    success: true,
                    message: 'Test webhook sent successfully',
                    details: {
                        test_id: testId,
                        response_status: response.status
                    }
                });
            }

            // Handle non-2xx responses
            return res.status(400).json({
                success: false,
                error: this.getErrorMessage(response.status),
                details: {
                    test_id: testId,
                    response_status: response.status
                }
            });

        } catch (error) {
            // Handle network or other errors
            const errorDetails = this.handleNetworkError(error);

            // Log the failure
            await this.logWebhookAttempt({
                testId,
                status: 'failed',
                error: errorDetails.message,
                errorCode: errorDetails.code
            });

            return res.status(400).json({
                success: false,
                error: errorDetails.message,
                details: {
                    test_id: testId,
                    error_code: errorDetails.code
                }
            });
        }
    }

    handleNetworkError(error) {
        const errorMap = {
            ECONNREFUSED: {
                message: 'Connection refused - the webhook endpoint is not accepting connections',
                code: 'ECONNREFUSED'
            },
            ENOTFOUND: {
                message: 'Domain not found - check if the webhook URL is correct',
                code: 'ENOTFOUND'
            },
            ETIMEDOUT: {
                message: 'Request timed out - webhook endpoint took too long to respond',
                code: 'ETIMEDOUT'
            },
            ECONNABORTED: {
                message: 'Request timed out - webhook endpoint took too long to respond',
                code: 'ECONNABORTED'
            }
        };

        return errorMap[error.code] || {
            message: error.message || 'Failed to deliver webhook',
            code: error.code || 'UNKNOWN_ERROR'
        };
    }

    async logWebhookAttempt({ testId, status, error = null, errorCode = null, responseStatus = null }) {
        const logData = {
            event: 'webhook.test',
            status,
            timestamp: FieldValue.serverTimestamp(),
            test_id: testId
        };

        if (responseStatus !== null) {
            logData.response_status = responseStatus;
        }

        if (error) {
            logData.error = error;
        }

        if (errorCode) {
            logData.error_code = errorCode;
        }

        const db = getFirestore();
        return db.collection('webhook_logs').add(logData);
    }

    getErrorMessage(status) {
        const statusMessages = {
            400: 'Webhook endpoint rejected the request as invalid',
            401: 'Webhook endpoint requires authentication',
            403: 'Webhook endpoint denied access',
            404: 'Webhook endpoint not found at this URL',
            405: 'Webhook endpoint does not accept POST requests',
            408: 'Webhook endpoint request timed out',
            429: 'Webhook endpoint rate limit exceeded',
            500: 'Webhook endpoint encountered an internal error',
            502: 'Bad gateway - intermediate server received an invalid response',
            503: 'Webhook endpoint is temporarily unavailable',
            504: 'Gateway timeout - intermediate server timed out'
        };

        return statusMessages[status] ||
            (status >= 400 && status < 500
                ? `Webhook endpoint returned client error (${status})`
                : status >= 500
                    ? `Webhook endpoint returned server error (${status})`
                    : 'Unknown error occurred');
    }
}

module.exports = WebhookController;