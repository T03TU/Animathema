"""Exercise real subprocess failure, queue handling, and cancellation cleanup."""
import asyncio
import sys
from backend.render_engine import Jobs


def test_subprocess_failure_is_reported_with_logs():
    async def run():
        engine=Jobs()
        async def runner(job):
            await engine.command(job,[sys.executable,'-c','print("diagnostic output",flush=True); raise SystemExit(3)'])
        result=engine.create('render',runner)
        job=engine.jobs[result['id']]
        await job['_task']
        assert job['status']=='failed'
        assert 'code 3' in job['error']
        assert any('diagnostic output' in line for line in job['logs'])
        await engine.close()
    asyncio.run(run())


def test_cancel_queued_and_running_jobs_cleans_up_process():
    async def run():
        engine=Jobs()
        async def runner(job):
            await engine.command(job,[sys.executable,'-c','import time; print("started",flush=True); time.sleep(30)'])
        first=engine.create('render',runner)
        second=engine.create('render',runner)
        job=engine.jobs[first['id']]
        async def wait_for_process():
            while job['_process'] is None:
                await asyncio.sleep(.01)
        await asyncio.wait_for(wait_for_process(),5)
        process=job['_process']
        await engine.cancel(engine.jobs[second['id']])
        assert engine.jobs[second['id']]['status']=='cancelled'
        await engine.cancel(job)
        assert job['status']=='cancelled'
        assert process.returncode is not None
        assert job['_process'] is None
        await engine.close()
    asyncio.run(run())
