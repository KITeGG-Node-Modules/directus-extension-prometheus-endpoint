import axios from 'axios'
import { getKeycloakClient } from 'kitegg-directus-extension-common'

export default {
	id: 'prometheus',
	handler: (router, context) => {
		router.get('/power/gpu', async (req, res, next) => {
			if (!req.accountability.user) {
				return res.status(401).send('Not authenticated')
			}
			try {
				const { data: responseData } = await getApiClient().get('query_range', {
					params: parseParams('DCGM_FI_DEV_POWER_USAGE', req.query)
				})
				const metricsTree = {}
				const { result: metricValues } = responseData.data
				for (const metricValue of metricValues) {
					const { metric } = metricValue
					const {
						kubernetes_node: node,
						gpu,
						GPU_I_PROFILE: gpuProfile,
						pod,
						container
					} = metric
					if (req.query.group === 'pod') {
						const sum = !!req.query.sum
						if (!metricsTree[pod]) metricsTree[pod] = {}
						if (!metricsTree[pod][container]) metricsTree[pod][container] = {
							default: [],
						}
						if (gpuProfile) {
							if (!metricsTree[pod][container][gpuProfile]) metricsTree[pod][container][gpuProfile] = []
							metricsTree[pod][container][gpuProfile].push(formatMetricValue(metricValue, sum))
						}
						else metricsTree[pod][container].default.push(formatMetricValue(metricValue, sum))
					} else {
						const gpuKey = `gpu-${gpu}`
						if (!metricsTree[node]) metricsTree[node] = {}
						if (!metricsTree[node][gpuKey]) {
							if (gpuProfile) metricsTree[node][gpuKey] = { [gpuProfile]: [] }
							else metricsTree[node][gpuKey] = []
						}
						if (gpuProfile) metricsTree[node][gpuKey][gpuProfile].push(formatMetricValue(metricValue))
						else metricsTree[node][gpuKey].push(formatMetricValue(metricValue))
					}
				}
				if (req.query.highscores) {
					const users = {}
					const { services } = context
					const { ItemsService } = services
					const deploymentsService = new ItemsService('deployments', {
						schema: req.schema
					})
					const usersService = new ItemsService('directus_users', {
						schema: req.schema
					})
					const rolesService = new ItemsService('directus_roles', {
						schema: req.schema
					})
					for (const podName in metricsTree) {
						if (podName.startsWith('sd-')) {
							const deploymentId = podName.slice(3, 39)
							try {
								const deployment = await deploymentsService.readOne(deploymentId)
								if (!users[deployment.user_created]) users[deployment.user_created] = 0
								for (const container in metricsTree[podName]) {
									for (const profile in metricsTree[podName][container]) {
										if (metricsTree[podName][container][profile].length === 1) {
											users[deployment.user_created] += metricsTree[podName][container][profile][0].value
										}
									}
								}
							} catch (error) {
								console.error('Failed to get deployment:', error.message)
							}
						} else if (podName.startsWith('jupyter-')) {
							const userName = podName.slice(8)
							if (!users[userName]) users[userName] = 0
							for (const container in metricsTree[podName]) {
								for (const profile in metricsTree[podName][container]) {
									if (metricsTree[podName][container][profile].length === 1) {
										users[userName] += metricsTree[podName][container][profile][0].value
									}
								}
							}
						}
					}
					const client = await getKeycloakClient()
					const leaderboard = []
					for (const userId in users) {
						let user
						try {
							if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(userId)) {
								const { data: keycloakUsers } = await client.get(`/users?username=${userId}&exact=true`)
								if (keycloakUsers.length) {
									const users = await usersService.readByQuery({ filter: { external_identifier: { _eq: keycloakUsers[0].id } } })
									user = users.shift()
								}
							} else {
								user = await usersService.readOne(userId)
							}
							if (user) {
								let roleName, institution
								if (user.role) {
									const role = await rolesService.readOne(user.role)
									if (role) {
										const parts = (role.name || '').split('/')
										if (parts.length === 2) {
											roleName = `${parts[1]}`.trim()
											institution = `${parts[2]}`.trim()
										}
									}
								}
								const existing = leaderboard.find(entry => entry.user === user.id)
								if (existing) {
									existing.wH += users[userId]
								} else {
									leaderboard.push({
										user: user.id,
										name: `${user.first_name} ${user.last_name}`,
										role: roleName,
										institution,
										wH: users[userId]
									})
								}
							}
						} catch (error) {
							console.error('Failed to get user:', error.message)
						}
					}
					return res.send(leaderboard.sort((a, b) => {
						if (a.wH < b.wH) return 1
						if (a.wH > b.wH) return -1
						return 0
					}))
				}
				res.send(metricsTree)
			} catch (err) {
				if (err.response) {
					res.status(err.response.status)
					return res.send(err.response.data)
				}
				return next(err)
			}
		})
		router.get('/power/gpu/pods', async (req, res, next) => {
			if (!req.accountability.user) {
				return res.status(401).send('Not authenticated')
			}
			try {
				const { data: responseData } = await getApiClient().get('query_range', {
					params: parseParams('DCGM_FI_DEV_POWER_USAGE', req.params)
				})
				const metricsByPod = []
				const { result: metricValues } = responseData.data
				for (const metricValue of metricValues) {
					const { metric } = metricValue
					if (metric.pod) metricsByPod.push(formatMetricValue(metricValue))
				}
				res.send(metricsByPod)
			} catch (err) {
				if (err.response) {
					res.status(err.response.status)
					return res.send(err.response.data)
				}
				return next(err)
			}
		})
		router.get('/power/instance', async (req, res, next) => {
			try {
				const { data: responseData } = await getApiClient().get('query_range', {
					params: parseParams('ipmi_dcmi_power_consumption_watts', req.params)
				})
				const metricsByInstance = []
				const { result: metricValues } = responseData.data
				for (const metricValue of metricValues) {
					metricsByInstance.push(formatMetricValue(metricValue))
				}
				res.send(metricsByInstance)
			} catch (err) {
				if (err.response) {
					res.status(err.response.status)
					return res.send(err.response.data)
				}
				return next(err)
			}
		})
	}
}

let _client
const getApiClient = () => {
	if (!_client) {
		_client = axios.create({
			baseURL: `${process.env.PROMETHEUS_HOST || 'http://localhost:9090'}/api/v1/`
		})
	}
	return _client
}

const KITEGG_HOSTS = [
	{ ip: '10.10.10.1', hostname: 'ctrl-a' },
	{ ip: '10.10.10.3', hostname: 'ctrl-b' },
	{ ip: '10.10.10.5', hostname: 'stor-a' },
	{ ip: '10.10.10.7', hostname: 'stor-b' },
	{ ip: '10.10.10.10', hostname: 'work-a' },
	{ ip: '10.10.10.12', hostname: 'work-b' },
	{ ip: '10.10.10.14', hostname: 'work-c' },
	{ ip: '10.10.10.16', hostname: 'work-d' },
	{ ip: '10.10.10.18', hostname: 'work-e' }
]
const getNodeNameFromInstance = instance => {
	return KITEGG_HOSTS.find(host => instance.startsWith(`${host.ip}:`))?.hostname
}
const formatMetricValue = (metricValue, sum) => {
	let {
		modelName,
		pod,
		instance,
		kubernetes_node: node,
		GPU_I_PROFILE: profile
	} = metricValue.metric
	if (instance && !node) {
		node = getNodeNameFromInstance(instance)
	}
	let value
	if (sum) {
		value = metricValue.values.reduce((acc, cur) => (acc + parseFloat(cur[1])), 0)
	}
	return {
		modelName,
		pod,
		node,
		profile,
		unit: 'W',
		values: !sum && metricValue.values?.length > 1 ? metricValue.values : undefined,
		value: sum || metricValue.values?.length === 1 ? value || (metricValue.values.shift())?.value : undefined
	}
}

const parseParams = (query, params) => {
	return {
		query,
		start: params.start || Date.now() / 1000 - 60 * 60 + 1,
		end: params.end || Date.now() / 1000,
		step: params.step || '30s'
	}
}
