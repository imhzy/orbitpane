from __future__ import annotations

import io
import json
import os
import smtplib
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import httpx
from pydantic import ValidationError

from backend.app.application import create_app
from backend.app.database import Database
from backend.app.plugins import PluginService, PluginUpdate, PluginCreate
from backend.app.plugins.stdio import serve
from backend.tests.helpers import test_settings

CONFIG = {"host": "smtp.example.com", "port": 465, "security": "tls", "username": "sender@example.com",
          "password": "private-authorization-code", "from_address": "sender@example.com", "from_name": "Test"}
ARGUMENTS = {"to": ["recipient@example.com"], "subject": "Hello", "text": "Message"}


class PluginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = test_settings(Path(self.temp.name))
        self.db = Database(self.settings.database_path)
        self.db.migrate()
        self.project = self.db.create_conversation("One", self.temp.name, "codex").id
        self.other = self.db.create_conversation("Two", self.temp.name, "codex").id
        self.service = PluginService(self.db, self.settings)
        self.instance = self.service.create(PluginCreate(plugin_id='send_email', name='Work email'))
        self.tool = 'send_email_' + self.instance

    def enable(self):
        self.service.save(self.instance, PluginUpdate(enabled=True, config=CONFIG))

    def test_secret_storage_and_partial_updates(self):
        self.enable()
        self.assertNotIn(CONFIG['password'], self.settings.database_path.read_bytes().decode(errors='ignore'))
        public = self.service.catalog()[0]
        self.assertNotIn('password', public['config'])
        self.assertEqual(public['configured_secrets'], ['password'])
        self.service.save(self.instance, PluginUpdate(enabled=True, config={'from_name': 'New'}))
        with patch('backend.app.plugins.mail.smtplib.SMTP_SSL') as smtp:
            smtp.return_value.__enter__.return_value = smtp.return_value
            smtp.return_value.send_message.return_value = {}
            self.service.call(self.project, self.tool, ARGUMENTS)
            smtp.return_value.login.assert_called_once_with(CONFIG['username'], CONFIG['password'])

    def test_global_availability_switch_and_project_deletion(self):
        self.assertEqual(self.service.tools(self.project), [])
        self.enable()
        self.assertEqual(len(self.service.tools(self.project)), 1)
        self.assertEqual(len(self.service.tools(self.other)), 1)
        self.service.save(self.instance, PluginUpdate(enabled=False))
        with self.assertRaises(ValueError):
            self.service.call(self.project, self.tool, ARGUMENTS)
        self.enable()
        self.db.delete_conversation(self.project)
        self.assertEqual(self.service.tools(self.project), [])
        with self.db.connect() as connection:
            self.assertEqual(connection.execute('SELECT count(*) FROM project_plugin_bindings').fetchone()[0], 0)
        self.assertEqual(len(self.service.catalog()), 1)

    def test_old_project_switches_do_not_restrict_global_plugins(self):
        self.enable()
        with self.db.connect() as connection:
            connection.execute('INSERT INTO project_plugin_bindings VALUES (?, ?, 0)',
                               (self.other, self.instance))
        self.assertEqual(len(self.service.tools(self.other)), 1)
        with patch('backend.app.plugins.mail.smtplib.SMTP_SSL') as smtp:
            smtp.return_value.__enter__.return_value = smtp.return_value
            smtp.return_value.send_message.return_value = {}
            self.service.call(self.other, self.tool, ARGUMENTS)
            smtp.return_value.send_message.assert_called_once()
        self.service.save(self.instance, PluginUpdate(enabled=False))
        self.assertEqual(self.service.tools(self.other), [])
        with self.assertRaises(ValueError):
            self.service.call(self.other, self.tool, ARGUMENTS)

    def test_invalid_config_and_header_injection_never_send(self):
        with self.assertRaises(ValidationError):
            self.service.save(self.instance, PluginUpdate(enabled=True, config={**CONFIG, 'port': 0}))
        with self.assertRaises(ValidationError):
            self.service.save(self.instance, PluginUpdate(enabled=True, config={**CONFIG, 'security': 'none'}))
        self.enable()
        for args in ({**ARGUMENTS, 'subject': 'Hello\r\nBcc: victim@example.com'},
                     {**ARGUMENTS, 'to': ['a@example.com\n']}, {**ARGUMENTS, 'unexpected': 1}):
            with patch('backend.app.plugins.mail.smtplib.SMTP_SSL') as smtp:
                with self.assertRaises(ValidationError):
                    self.service.call(self.project, self.tool, args)
                smtp.assert_not_called()

    def test_key_rotation_can_disable_and_replace_secret(self):
        self.enable()
        service = PluginService(self.db, replace(self.settings, auth_secret='rotated'))
        with self.assertRaises(ValueError):
            service.call(self.project, self.tool, ARGUMENTS)
        service.save(self.instance, PluginUpdate(enabled=False))
        service.save(self.instance, PluginUpdate(enabled=True, config={'password': 'new-secret'}))

    def test_starttls_and_redacted_failure(self):
        self.service.save(self.instance, PluginUpdate(enabled=True, config={**CONFIG, 'security': 'starttls', 'port': 587}))
        with patch('backend.app.plugins.mail.smtplib.SMTP') as smtp:
            client = smtp.return_value
            client.__enter__.return_value = client
            client.send_message.return_value = {'recipient@example.com': (550, b'rejected')}
            result = self.service.call(self.project, self.tool, ARGUMENTS)
            client.starttls.assert_called_once()
            self.assertEqual(result['status'], 'partially_accepted')
            client.login.side_effect = smtplib.SMTPAuthenticationError(535, CONFIG['password'])
            with self.assertRaises(ValueError) as error:
                self.service.call(self.project, self.tool, ARGUMENTS)
            self.assertNotIn(CONFIG['password'], str(error.exception))

    def test_multiple_instances_shared_config_and_revocation(self):
        self.enable()
        second = self.service.create(PluginCreate(plugin_id='send_email', name='Personal'))
        self.service.save(second, PluginUpdate(enabled=True, config={**CONFIG, 'username': 'personal@example.com'}))
        self.assertEqual(len(self.service.tools(self.project)), 2)
        self.assertEqual(len(self.service.tools(self.other)), 2)
        self.assertEqual(len({t['name'] for t in self.service.tools(self.project)}), 2)
        self.service.save(self.instance, PluginUpdate(enabled=False))
        self.assertEqual(len(self.service.tools(self.other)), 1)
        with self.assertRaises(ValueError):
            self.service.call(self.other, self.tool, ARGUMENTS)
        self.db.delete_plugin(second)
        self.assertEqual(self.service.tools(self.project), [])

    def test_legacy_migration_preserves_secrets_and_is_idempotent(self):
        config = {**CONFIG, 'password': self.service._seal(CONFIG['password'], self.project, 'send_email', 'password')}
        with self.db.connect() as connection:
            connection.execute('INSERT INTO project_plugins VALUES (?, ?, ?, ?)', (self.project, 'send_email', 1, json.dumps(config)))
        self.db.migrate()
        self.db.migrate()
        migrated = [p for p in self.service.catalog() if p['id'].startswith('legacy_')]
        self.assertEqual(len(migrated), 1)
        self.assertEqual(migrated[0]['configured_secrets'], ['password'])
        self.assertEqual(len(self.service.tools(self.project)), 1)
        with patch('backend.app.plugins.mail.smtplib.SMTP_SSL') as smtp:
            smtp.return_value.__enter__.return_value = smtp.return_value
            smtp.return_value.send_message.return_value = {}
            self.service.call(self.project, self.service.tools(self.project)[0]['name'], ARGUMENTS)
            smtp.return_value.login.assert_called_once_with(CONFIG['username'], CONFIG['password'])
        self.db.delete_conversation(self.project)
        self.assertEqual(len(self.service.catalog()), 2)

    def test_real_mcp_process_and_run_scope(self):
        from backend.app.agents.base import AgentRequest
        from backend.app.agents.plugins import launch, environment, codex_args
        from backend.app.config import PROJECT_ROOT
        self.enable()
        settings = replace(self.settings, allowed_roots=(Path(self.temp.name), PROJECT_ROOT))
        self.db.create_run('plugin-test', self.project, status='running', prompt='Test', model='test', provider='codex', is_summary=False)
        request = AgentRequest('plugin-test', self.project, self.temp.name, 'Test', (), 'test')
        command, args = launch(settings)
        self.assertNotIn(settings.auth_secret, ' '.join(codex_args(settings, request)))
        self.assertNotIn(CONFIG['password'], ' '.join(args))
        messages = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
                    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'}]
        result = subprocess.run([command, *args], input='\n'.join(map(json.dumps, messages))+'\n', text=True,
                                capture_output=True, timeout=10, cwd=self.temp.name,
                                env={**os.environ, **environment(settings, request)})
        self.assertEqual(result.returncode, 0, result.stderr)
        responses = list(map(json.loads, result.stdout.splitlines()))
        self.assertEqual(responses[1]['result']['tools'][0]['name'], self.tool)
        self.assertTrue(self.db.plugin_run_active(self.project, 'plugin-test'))
        self.assertFalse(self.db.plugin_run_active(self.other, 'plugin-test'))
        self.db.update_run('plugin-test', status='completed')
        self.assertFalse(self.db.plugin_run_active(self.project, 'plugin-test'))
        result = subprocess.run([command, *args], input=json.dumps(messages[1])+'\n', text=True,
                                capture_output=True, timeout=10, cwd=self.temp.name,
                                env={**os.environ, **environment(settings, request)})
        self.assertEqual(json.loads(result.stdout)['result']['tools'], [])

    def test_mcp_no_scope_never_exposes_tools(self):
        self.enable()
        requests = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
                    {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                    {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'send_email', 'arguments': ARGUMENTS}}]
        output = io.StringIO()
        with patch.dict(os.environ, {'ORBITPANE_PLUGIN_PROJECT': '0', 'ORBITPANE_PLUGIN_RUN': ''}), patch('sys.stdin', io.StringIO('\n'.join(map(json.dumps, requests)))), patch('sys.stdout', output):
            serve()
        responses = list(map(json.loads, output.getvalue().splitlines()))
        self.assertEqual(len(responses), 3)
        self.assertEqual(responses[1]['result']['tools'], [])
        self.assertTrue(responses[2]['result']['isError'])


class PluginApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_auth_validation_redaction_and_persistence(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(test_settings(Path(directory)))
            async with app.router.lifespan_context(app):
                project = app.state.database.create_conversation('Project', directory, 'codex')
                project_url = f'/api/conversations/{project.id}/plugins'
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                    for method, url, payload in [('GET', '/api/plugins', None), ('POST', '/api/plugins', {'plugin_id': 'send_email', 'name': 'Test'}),
                                                 ('PUT', '/api/plugins/nope', {'enabled': False}), ('DELETE', '/api/plugins/nope', None)]:
                        self.assertEqual((await client.request(method, url, json=payload)).status_code, 401)
                    await client.post('/api/login', json={'pin': 'test-pin'})
                    result = await client.post('/api/plugins', json={'plugin_id': 'send_email', 'name': 'Work'})
                    self.assertEqual(result.status_code, 201)
                    instance = result.json()['id']
                    url = '/api/plugins/' + instance
                    result = await client.put(url, json={'enabled': True, 'config': CONFIG})
                    self.assertEqual(result.status_code, 200, result.text)
                    self.assertNotIn(CONFIG['password'], result.text)
                    self.assertTrue((await client.get('/api/plugins')).json()['items'][0]['enabled'])
                    self.assertNotIn('project_enabled', (await client.get('/api/plugins')).json()['items'][0])
                    service = PluginService(app.state.database, test_settings(Path(directory)))
                    self.assertEqual(len(service.tools(project.id)), 1)
                    self.assertEqual((await client.get(project_url)).status_code, 404)
                    self.assertEqual((await client.put(project_url+'/'+instance, json={'enabled': True})).status_code, 404)
                    result = await client.put(url, json={'enabled': True, 'config': {'password': 123}})
                    self.assertEqual(result.status_code, 422)
                    self.assertNotIn('123', result.text)
                    self.assertEqual((await client.get('/api/conversations/999/plugins')).status_code, 404)
                    self.assertEqual((await client.post('/api/plugins', json={'plugin_id': 'unknown', 'name': 'X'})).status_code, 422)
                    self.assertEqual((await client.delete(url)).status_code, 200)
                    self.assertEqual((await client.get('/api/plugins')).json()['items'], [])
